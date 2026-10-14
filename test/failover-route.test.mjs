// Failover inside a real Alexa turn. The providers are mocked at the module
// boundary so the real llmService and the real route run between them - which
// is the only place to check that a slow fallback is handed to the job
// registry instead of making Alexa wait.
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

// Read once when the modules load, so they are set before any import.
process.env.GROQ_TIMEOUT_MS = "100";
process.env.TURN_DEADLINE_MS = "500";
process.env.BREAKER_COOLDOWN_MS = "60000";
process.env.LLM_PRIMARY = "groq";
process.env.EXECUTOR_URL = "http://127.0.0.1:9/execute";

const providers = {};

// Each mocked provider takes its behaviour from `providers`, set per test.
const mockProvider = (name) => ({ timeoutMs }) => ({
  name,
  timeoutMs,
  complete: (request) => {
    providers[name].calls += 1;
    return providers[name].behaviour(request);
  },
  warmUp: async () => {
    providers[name].warmed += 1;
    return true;
  },
});

providers.groq = { calls: 0, warmed: 0, behaviour: null };
providers.ollama = { calls: 0, warmed: 0, behaviour: null };

mock.module(new URL("../src/services/providers/groqProvider.js", import.meta.url).href, {
  namedExports: { createGroqProvider: mockProvider("groq") },
});

mock.module(new URL("../src/services/providers/ollamaProvider.js", import.meta.url).href, {
  namedExports: { createOllamaProvider: mockProvider("ollama") },
});

const { default: app } = await import("../src/app.js");
const { clearAllJobs, getAllJobs } = await import("../src/data/jobRegistry.js");
const { warmUpProviders } = await import("../src/services/llmService.js");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/alexa`;
});

after(() => server?.close());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  return {
    text: (body.response.outputSpeech.ssml ?? "").replace(/<[^>]+>/g, "").trim(),
    end: body.response.shouldEndSession,
  };
};

const reply = (content, delayMs = 0) => async () => {
  await sleep(delayMs);
  return { message: { role: "assistant", content }, usage: {}, finishReason: "stop" };
};

const hang = ({ signal }) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });

// Order matters in this file: the first failure opens the breaker, and the
// tests after it rely on that rather than reset it.

test("groq answering is spoken as before", async () => {
  providers.groq.behaviour = reply("It is Thursday.");
  providers.ollama.behaviour = reply("wrong provider");

  const turn = await say("route-1", "what day is it");

  assert.equal(turn.text, "It is Thursday.");
  assert.equal(turn.end, false);
  assert.equal(providers.ollama.calls, 0);
});

test("a groq timeout is answered by ollama within the same turn", async () => {
  providers.groq.behaviour = hang;
  providers.ollama.behaviour = reply("Ollama says it is Thursday.", 50);

  const turn = await say("route-2", "what day is it");

  assert.equal(turn.text, "Ollama says it is Thursday.");
  assert.equal(turn.end, false);
  assert.equal(providers.ollama.calls, 1);
});

test("a fallback too slow for the turn goes to the job registry instead of making Alexa wait", async () => {
  clearAllJobs();

  const groqCallsBefore = providers.groq.calls;

  // Slower than the 500ms turn deadline. The breaker is open from the test
  // above, so groq is skipped and all of the time is the local model's.
  providers.ollama.behaviour = reply("The local answer.", 900);

  const started = Date.now();
  const turn = await say("route-3", "explain closures");
  const waited = Date.now() - started;

  assert.match(turn.text, /shifting it to the background/);
  assert.equal(turn.end, true);
  assert.ok(waited < 850, `Alexa waited ${waited}ms - should be released at the turn deadline`);
  assert.equal(providers.groq.calls, groqCallsBefore, "breaker should have skipped groq");

  const [job] = getAllJobs();

  assert.equal(job.status, "running");

  await sleep(700);

  assert.equal(job.status, "done");
  assert.equal(job.result.reply, "The local answer.");
});

test("both providers are warmed at start, and either can opt out", async () => {
  await warmUpProviders();

  assert.equal(providers.groq.warmed, 1);
  assert.equal(providers.ollama.warmed, 1);

  process.env.GROQ_WARMUP = "false";
  await warmUpProviders();
  delete process.env.GROQ_WARMUP;

  assert.equal(providers.groq.warmed, 1, "GROQ_WARMUP=false skips groq");
  assert.equal(providers.ollama.warmed, 2);

  process.env.OLLAMA_WARMUP = "false";
  await warmUpProviders();
  delete process.env.OLLAMA_WARMUP;

  assert.equal(providers.groq.warmed, 2);
  assert.equal(providers.ollama.warmed, 2, "OLLAMA_WARMUP=false skips ollama");
});
