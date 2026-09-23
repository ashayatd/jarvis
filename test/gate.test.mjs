// Covers the confirmation gate end to end: the real Express app, the real
// tool registry and a real executor.py subprocess. Only the model is faked,
// so the scripted tool calls stand in for whatever Groq would have asked for.
//
//   npm test
//
// Needs python with flask on PATH. The executor is started on its own port
// and torn down with the suite, so nothing has to be running beforehand.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const EXECUTOR_PORT = 5099;
const SECRET = "test_secret";

// Set before app.js is imported: it reads the executor URL at module load.
process.env.EXECUTOR_URL = `http://127.0.0.1:${EXECUTOR_PORT}/execute`;
process.env.EXECUTOR_SECRET = SECRET;

// node -p evaluates its argument and prints the result, which makes it a
// stand-in for `claude -p <prompt>` that needs no API key and proves the
// prompt arrived unmangled.
process.env.EXECUTOR_CLAUDE_BIN = process.execPath;

// One scripted assistant reply is consumed per generateAIReply call.
const scripted = [];

mock.module(new URL("../src/services/groqService.js", import.meta.url).href, {
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

let executor;
let server;
let base;

const waitForExecutor = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(process.env.EXECUTOR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Executor-Secret": SECRET },
        body: JSON.stringify({ command: "job_status", args: { job_id: "none" } }),
      });

      // 404 for the unknown job is a healthy executor answering.
      if (res.status === 404) return;
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("executor.py did not come up");
};

before(async () => {
  executor = spawn("python", ["executor.py"], {
    cwd: root,
    env: {
      ...process.env,
      EXECUTOR_PORT: String(EXECUTOR_PORT),
      EXECUTOR_SECRET: SECRET,
    },
    stdio: "ignore",
  });

  await waitForExecutor();

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/alexa`;
});

after(() => {
  server?.close();
  executor?.kill();
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

  return {
    text: body.response.outputSpeech.text,
    end: body.response.shouldEndSession,
  };
};

const toolCall = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", function: { name, arguments: JSON.stringify(args) } }],
});

const shell = (command) => toolCall("run_command", { command });

// --- exit and farewell matching ------------------------------------------

test("an exit phrase ends the session", async () => {
  const r = await say("exit1", "exit ai mode");
  assert.equal(r.end, true);
});

test("a command that merely contains an exit word does not", async () => {
  scripted.push({ role: "assistant", content: "Closing it now." });
  const r = await say("exit2", "close VS code");
  assert.equal(r.end, false);
  assert.equal(r.text, "Closing it now.");
});

// --- the confirmation gate ------------------------------------------------

test("a mutating command is gated, not executed", async () => {
  scripted.push(shell("git commit -m wip"));
  const r = await say("s1", "commit my work");
  assert.equal(r.text, "That will run git commit -m wip. Say yes to confirm.");
  assert.equal(r.end, false);
});

test("yes releases the held command", async () => {
  const r = await say("s1", "yes");
  assert.doesNotMatch(r.text, /not on the allowed list/);
  assert.match(r.text, /Done\.|didn't work|running now/);
});

test("the gate does not stay armed once it has fired", async () => {
  scripted.push({ role: "assistant", content: "Anything else?" });
  const r = await say("s1", "yes");
  assert.equal(r.text, "Anything else?");
});

test("anything other than yes aborts and is handled as a normal turn", async () => {
  scripted.push(shell("npm install left-pad"));
  const gated = await say("s2", "install left pad");
  assert.match(gated.text, /Say yes to confirm/);

  scripted.push({ role: "assistant", content: "Okay, skipped." });
  const aborted = await say("s2", "actually tell me a joke");
  assert.equal(aborted.text, "Okay, skipped.");
});

test("a chained command is refused outright, never offered for confirmation", async () => {
  scripted.push(shell("git status && rm -rf ."));
  scripted.push({ role: "assistant", content: "I can't run that." });
  const r = await say("s3", "run something sneaky");
  assert.equal(r.text, "I can't run that.");
});

// --- the read-only fast track --------------------------------------------

test("an allowlisted read-only command skips the gate despite matching a prefix", async () => {
  scripted.push(shell("git status"));
  scripted.push({ role: "assistant", content: "You have four modified files." });
  const r = await say("s4", "what's my git status");
  assert.equal(r.text, "You have four modified files.");
});

test("a non-allowlisted command with the same prefix is still gated", async () => {
  scripted.push(shell("git push"));
  const r = await say("s5", "push my work");
  assert.match(r.text, /Say yes to confirm/);
});

// --- the dedicated Claude tool -------------------------------------------

test("a Claude run is gated and reads the prompt back", async () => {
  scripted.push(toolCall("run_claude", { prompt: "build a landing page" }));
  const r = await say("c1", "build me a landing page");
  assert.equal(r.text, "That will run Claude with: build a landing page. Say yes to confirm.");
});

test("a confirmed Claude run is released to the CLI", async () => {
  const r = await say("c1", "do it");

  // The stand-in is node -p, so "build a landing page" is not valid input and
  // comes back as a failure. That it ran at all is the point: what must never
  // appear here is a refusal.
  assert.doesNotMatch(r.text, /not on the allowed list|not confirmed/);
  assert.match(r.text, /Done\.|didn't work|running now/);
});

test("shell metacharacters survive in a Claude prompt", async () => {
  // Evaluated by the node stand-in: a shell would have mangled $x and (y),
  // so getting the length of the literal string back proves argv was used.
  scripted.push(toolCall("run_claude", { prompt: '"a$x(y)".length' }));
  const gated = await say("c2", "count that string");
  assert.match(gated.text, /Say yes to confirm/);

  const r = await say("c2", "yes");
  assert.match(r.text, /Done\. 6/);
});

test("an unconfirmed Claude run is refused by the handler too", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "run_claude", arguments: JSON.stringify({ prompt: "delete everything" }) } },
    { sessionKey: "direct" },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /not confirmed/);
});
