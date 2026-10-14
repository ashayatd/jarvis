// Handing long work off and closing the session. Its own file because the tool
// deadline is read once when the route module loads, so forcing everything to be
// backgrounded has to happen before any import - and the test runner gives each
// file its own process.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, mock, test } from "node:test";

// Lower than the first poll interval, so anything that goes to the executor is
// certain to miss the deadline and be handed to the job registry. Without this
// the outcome depends on how fast a stub answers, which is not a test.
process.env.TOOL_DEADLINE_MS = "50";

// The stub never reports the job finished, which is the state under test - but
// the poll loop would then keep a timer chain alive for its full budget and the
// test process could not exit. Two seconds is long enough for every assertion
// below and short enough not to hang the run.
process.env.EXECUTOR_JOB_TIMEOUT_MS = "2000";

// Answers, but never finishes: a running job is what closing depends on.
const stub = http.createServer((req, res) => {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    const { command } = JSON.parse(body);

    const reply =
      command === "job_status"
        ? { ok: true, status: "running" }
        : { ok: true, status: "running", job_id: "handoff1" };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.EXECUTOR_URL = `http://127.0.0.1:${stub.address().port}/execute`;
process.env.EXECUTOR_SECRET = "test_secret";

const scripted = [];

mock.module(new URL("../src/services/llmService.js", import.meta.url).href, {
  namedExports: {
    generateAIReply: async () => {
      if (!scripted.length) {
        throw new Error("generateAIReply called with no scripted reply left");
      }

      return scripted.shift();
    },
  },
});

const { default: app } = await import("../src/app.js");
const { clearAllJobs, getAllJobs } = await import("../src/data/jobRegistry.js");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/alexa`;
});

after(() => {
  server?.close();
  // The stub has to be closed too: an open listener keeps the event loop alive
  // and the test process simply never exits.
  stub.close();
});

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

const claudeCall = (prompt) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "c1", function: { name: "run_claude", arguments: JSON.stringify({ prompt }) } },
  ],
});

test("a job that goes to the background closes the session", async () => {
  clearAllJobs();

  scripted.push(claudeCall("build a whole design system"));
  const r = await say("h1", "build me a design system");

  // The point: nothing will be said for minutes, so leaving the ring lit until
  // Alexa gives up is worse than closing cleanly.
  assert.equal(r.end, true);
  assert.equal(r.reprompt, null, "a closing response has no reprompt to give");
  assert.match(r.text, /running in the background/i);

  // ...and it has to say how to get back in, because the mic is now shut.
  assert.match(r.text, /status update/i);
});

test("the job it handed off is still there afterwards", () => {
  const jobs = getAllJobs();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "running");
});

test("re-opening finds the job and can report on it", async () => {
  const { runTool } = await import("../src/tools/registry.js");

  // A different session id, as a fresh launch produces. The job was started by
  // a conversation that no longer exists, and must still be answerable.
  const result = await runTool(
    { function: { name: "check_background_jobs", arguments: "{}" } },
    { sessionKey: "a-completely-new-session" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.still_running, 1);
  assert.match(result.jobs[0].what, /design system/);
});

test("an answer with nothing in flight keeps the mic open", async () => {
  clearAllJobs();

  scripted.push({ role: "assistant", content: "It is Thursday." });
  const r = await say("h2", "what day is it");

  assert.equal(r.end, false);
  assert.ok(r.reprompt);
});
