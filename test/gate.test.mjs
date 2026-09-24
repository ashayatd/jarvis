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
import fs from "node:fs";
import os from "node:os";
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

// A throwaway workspace: these tests create folders and repos, and must not
// touch the real one. Set here rather than in the spawn env because
// executor.py reads .env, where this is also configured, and an existing
// environment variable is what wins over it.
const workspace = path.join(os.tmpdir(), `jarvis-test-workspace-${process.pid}`);
fs.mkdirSync(path.join(workspace, "landing-page"), { recursive: true });
process.env.EXECUTOR_WORKDIR = workspace;

// Stops a real editor window opening for every case that reaches VS Code.
process.env.EXECUTOR_VSCODE_BIN = "cmd /c echo";

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
      // The node stand-in reads its script from the first argument, so it
      // cannot also be passed --permission-mode. Empty disables the flag.
      EXECUTOR_CLAUDE_PERMISSION_MODE: "",
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
  fs.rmSync(workspace, { recursive: true, force: true });
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

// Built-in intents carry a name and no slots, which is exactly the shape that
// used to fall through to the "say tell me" message.
const sayIntent = async (sessionId, intentName, slots) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session: { sessionId },
      request: {
        type: "IntentRequest",
        intent: { name: intentName, ...(slots ? { slots } : {}) },
      },
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

test("shell metacharacters survive the trip to the CLI", async () => {
  // Straight at the executor, because the tool handler appends the autonomy
  // instruction and node -p would then have invalid input to evaluate. What
  // is under test here is executor.py: the prompt becomes one argv entry with
  // no shell involved, so $x and (y) arrive as themselves. A shell would have
  // eaten both, and the length would not come back as 6.
  const start = await fetch(process.env.EXECUTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Executor-Secret": SECRET },
    body: JSON.stringify({ command: "start_claude", args: { prompt: '"a$x(y)".length' } }),
  });

  const { job_id: jobId } = await start.json();

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await fetch(process.env.EXECUTOR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Executor-Secret": SECRET },
      body: JSON.stringify({ command: "job_status", args: { job_id: jobId } }),
    });

    const status = await res.json();

    if (status.status !== "running") {
      assert.equal(status.status, "done");
      assert.match(status.output, /^6/);
      return;
    }
  }

  throw new Error("stand-in CLI never finished");
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

// --- the VS Code project workflow ----------------------------------------

test("no tool can open VS Code without a project", async () => {
  const { toolSchemas } = await import("../src/tools/registry.js");
  const names = toolSchemas.map((schema) => schema.function.name);

  assert.ok(names.includes("open_project"));

  // open_app is the tool that would have dropped the user into the workspace
  // root. It must no longer know what VS Code is.
  const openApp = toolSchemas.find((schema) => schema.function.name === "open_app");
  assert.doesNotMatch(openApp.function.parameters.properties.app.description, /vs ?code/i);
});

test("check_directory finds an existing project", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "check_directory", arguments: JSON.stringify({ project: "landing page" }) } },
    {},
  );

  assert.equal(result.ok, true);
  assert.equal(result.exists, true);
  assert.equal(result.project, "landing-page");
});

test("check_directory reports a missing project and lists what there is", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "check_directory", arguments: JSON.stringify({ project: "invoice tracker" }) } },
    {},
  );

  assert.equal(result.exists, false);
  assert.deepEqual(result.projects, ["landing-page"]);
});

test("a project name cannot climb out of the workspace", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "check_directory", arguments: JSON.stringify({ project: "../../Windows/System32" }) } },
    {},
  );

  assert.equal(result.ok, true);
  assert.equal(path.dirname(result.path), workspace);
});

test("open_project refuses a folder that is not there", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "open_project", arguments: JSON.stringify({ project: "nothing here" }) } },
    {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.exists, false);
});

test("open_project opens an existing folder with no confirmation", async () => {
  scripted.push(toolCall("open_project", { project: "landing page" }));
  scripted.push({ role: "assistant", content: "Landing page is open." });
  const r = await say("v1", "landing page");

  assert.equal(r.text, "Landing page is open.");
});

test("init_project asks its own question rather than the default wording", async () => {
  scripted.push(toolCall("init_project", { project: "invoice tracker" }));
  const r = await say("v2", "invoice tracker");

  assert.equal(r.text, "That project isn't present. Should I initialize a new repo?");
  assert.equal(r.end, false);
});

test("confirming creates the folder, the repo and opens it", async () => {
  const r = await say("v2", "yes");

  assert.doesNotMatch(r.text, /not confirmed|didn't work/);
  assert.ok(fs.existsSync(path.join(workspace, "invoice-tracker", ".git")));
});

test("an unconfirmed init is refused by the handler too", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "init_project", arguments: JSON.stringify({ project: "sneaky" }) } },
    {},
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /not confirmed/);
  assert.ok(!fs.existsSync(path.join(workspace, "sneaky")));
});

// --- utterances that carry no query --------------------------------------

test("AMAZON.StopIntent ends the session instead of asking for a carrier phrase", async () => {
  const r = await sayIntent("b1", "AMAZON.StopIntent");

  assert.equal(r.end, true);
  assert.doesNotMatch(r.text, /tell me/i);
});

test("AMAZON.CancelIntent ends the session too", async () => {
  const r = await sayIntent("b2", "AMAZON.CancelIntent");

  assert.equal(r.end, true);
});

test("AMAZON.HelpIntent explains itself and keeps the mic open", async () => {
  const r = await sayIntent("b3", "AMAZON.HelpIntent");

  assert.equal(r.end, false);
  assert.match(r.text, /open VS Code/);
});

test("a fallback asks the user to repeat without teaching a carrier phrase", async () => {
  const r = await sayIntent("b4", "AMAZON.FallbackIntent");

  assert.equal(r.end, false);
  assert.doesNotMatch(r.text, /tell me/i);
  assert.match(r.text, /say it again/i);
});

test("a run of fallbacks escalates to advice that works on any model", async () => {
  await sayIntent("b4b", "AMAZON.FallbackIntent");
  const second = await sayIntent("b4b", "AMAZON.FallbackIntent");
  const third = await sayIntent("b4b", "AMAZON.FallbackIntent");

  // Repeating one useless line is the thing being complained about. The way
  // out has to be offered, even though it is a workaround for a stale model.
  assert.match(second.text, /tell me/i);
  assert.match(third.text, /tell me/i);
  assert.equal(second.end, false);
});

test("one understood utterance clears the streak", async () => {
  await sayIntent("b4c", "AMAZON.FallbackIntent");
  await sayIntent("b4c", "AMAZON.FallbackIntent");

  scripted.push({ role: "assistant", content: "Understood." });
  const good = await sayIntent("b4c", "AskIntent", { query: { name: "query", value: "what day is it" } });
  assert.equal(good.text, "Understood.");

  const afterwards = await sayIntent("b4c", "AMAZON.FallbackIntent");
  assert.match(afterwards.text, /say it again/i);
});

// --- slot extraction ------------------------------------------------------

test("an empty slot ahead of a filled one does not lose the utterance", async () => {
  scripted.push({ role: "assistant", content: "Got it." });

  // The shape an intent with more than one slot actually sends: the unused
  // slot is present but has no value, and it comes first.
  const r = await sayIntent("b5", "AskIntent", {
    carrier: { name: "carrier" },
    query: { name: "query", value: "what is my git status" },
  });

  assert.equal(r.text, "Got it.");
});

// --- carrier phrases in the spoken text ----------------------------------

test("a carrier phrase does not stop an exit phrase matching", async () => {
  const r = await sayIntent("b6", "AskIntent", { query: { name: "query", value: "tell me stop" } });

  assert.equal(r.end, true);
});

test("a carrier phrase does not stop a confirmation matching", async () => {
  scripted.push(toolCall("init_project", { project: "carrier test" }));
  const gated = await say("b7", "carrier test");
  assert.match(gated.text, /Should I initialize a new repo/);

  const r = await sayIntent("b7", "AskIntent", { query: { name: "query", value: "jarvis yes" } });
  assert.doesNotMatch(r.text, /not confirmed/);
  assert.ok(fs.existsSync(path.join(workspace, "carrier-test", ".git")));
});

test("a carrier phrase on a real question is still passed to the model", async () => {
  scripted.push({ role: "assistant", content: "It is Tuesday." });
  const r = await sayIntent("b8", "AskIntent", { query: { name: "query", value: "tell me what day it is" } });

  assert.equal(r.end, false);
  assert.equal(r.text, "It is Tuesday.");
});

// --- the autonomy instruction --------------------------------------------

test("the appended instruction is never read back to the user", async () => {
  const { AUTONOMOUS_SUFFIX } = await import("../src/data/chatMemory.js");

  scripted.push(toolCall("run_claude", { prompt: `build a landing page

${AUTONOMOUS_SUFFIX}` }));
  const r = await say("a1", "build me a landing page");

  assert.equal(r.text, "That will run Claude with: build a landing page. Say yes to confirm.");
  assert.doesNotMatch(r.text, /autonomous developer/);
});

test("the system prompt carries the rule and the exact wording", async () => {
  const { SYSTEM_PROMPT, AUTONOMOUS_SUFFIX } = await import("../src/data/chatMemory.js");

  assert.match(SYSTEM_PROMPT, /run_claude/);
  assert.ok(SYSTEM_PROMPT.includes(AUTONOMOUS_SUFFIX));
});
