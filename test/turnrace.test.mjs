// The turn deadline: what happens when a whole turn runs longer than Alexa will
// wait. Its own file because the deadline is read once when the route module
// loads, so forcing it has to happen before any import.
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

// Short enough to hit deliberately, long enough that a fast turn still wins.
process.env.TURN_DEADLINE_MS = "300";

// Nothing should reach a real executor here; a tool call would be a bug in the
// test rather than something to serve.
process.env.EXECUTOR_URL = "http://127.0.0.1:9/execute";

// How long the next model call takes, set per test.
let replyDelayMs = 0;
const scripted = [];

mock.module(new URL("../src/services/llmService.js", import.meta.url).href, {
  namedExports: {
    generateAIReply: async () => {
      if (!scripted.length) {
        throw new Error("generateAIReply called with no scripted reply left");
      }

      // Claimed on the way in, not after the delay. A slow turn overlaps with
      // the turn that follows it here, and taking the reply late meant the fast
      // turn walked off with the slow one's answer - a bug in the harness that
      // looked exactly like a bug in the detaching.
      const reply = scripted.shift();
      const delay = replyDelayMs;

      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      return reply;
    },
  },
});

const { default: app } = await import("../src/app.js");
const { clearAllJobs, getAllJobs } = await import("../src/data/jobRegistry.js");
const { runTool } = await import("../src/tools/registry.js");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/alexa`;
});

after(() => server?.close());

const say = async (sessionId, text) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session: { sessionId },
      request: { type: "IntentRequest", intent: { slots: { q: { value: text } } } },
    }),
  });

  const body = await res.json();
  const ssml = body.response.outputSpeech.ssml ?? "";

  return {
    text: ssml.replace(/<[^>]+>/g, "").trim(),
    reprompt: body.response.reprompt?.outputSpeech?.ssml ?? null,
    end: body.response.shouldEndSession,
  };
};

test("a turn that answers in time is returned as normal", async () => {
  clearAllJobs();
  replyDelayMs = 0;

  scripted.push({ role: "assistant", content: "It is Thursday." });
  const r = await say("fast", "what day is it");

  assert.equal(r.text, "It is Thursday.");
  assert.equal(r.end, false, "a normal answer keeps the mic open");
  assert.ok(r.reprompt);
  assert.equal(getAllJobs().length, 0, "nothing should have been handed off");
});

test("a turn that runs long is shifted to the background and the session closes", async () => {
  clearAllJobs();
  replyDelayMs = 900;

  scripted.push({ role: "assistant", content: "Here is the long answer." });
  const r = await say("slow", "explain the whole architecture");

  assert.equal(
    r.text,
    "This is a heavy task, I am shifting it to the background. Ask for a status update in a minute.",
  );
  assert.equal(r.end, true, "the ring must not be left lit with nothing to say");
  assert.equal(r.reprompt, null, "a closing response has no reprompt");
});

test("the abandoned turn is registered as a job while it is still running", () => {
  const jobs = getAllJobs();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "running");
  assert.match(jobs[0].label, /explain the whole architecture/);
});

test("its answer lands in the registry when it finishes", async () => {
  // Longer than the model delay, so the turn has certainly completed.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const [job] = getAllJobs();

  assert.equal(job.status, "done", "the work must not be abandoned when nobody waits");
  assert.equal(job.result.reply, "Here is the long answer.");
});

test("asking later retrieves it, from a conversation that never saw it", async () => {
  const result = await runTool(
    { function: { name: "check_background_jobs", arguments: "{}" } },
    { sessionKey: "a-much-later-session" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].status, "done");
  assert.equal(result.jobs[0].result.reply, "Here is the long answer.");
});

test("the next turn starts from a history the abandoned turn cannot reach", async () => {
  clearAllJobs();
  replyDelayMs = 900;

  scripted.push({ role: "assistant", content: "slow one" });
  await say("detach", "something slow");

  // The turn above is still running and will append to the memory it holds. If
  // that were still the session's memory, its writes would interleave with the
  // turn below and strand a tool message from its parent - which the API
  // rejects, so one slow turn would break every turn after it.
  replyDelayMs = 0;
  scripted.push({ role: "assistant", content: "quick one" });
  const second = await say("detach", "something quick");

  assert.equal(second.text, "quick one");
  assert.equal(second.end, false, "the next turn is a normal turn again");

  // And the slow turn still lands its own answer, in its own job, rather than
  // the two getting tangled.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const [job] = getAllJobs();
  assert.equal(job.status, "done");
  assert.equal(job.result.reply, "slow one");

  clearAllJobs();
});
