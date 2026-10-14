// The voice path end to end: the real Express app, the real tool registry and a
// real executor.py subprocess. Only the model is faked, so the scripted tool
// calls stand in for whatever Groq would have asked for.
//
// There is no confirmation step any more. Several tests here exist to hold that
// line from the other side - asserting that nothing asks the user to say yes -
// while the rules that did survive (no chaining, nothing outside the workspace)
// are asserted to still refuse.
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
fs.mkdirSync(path.join(workspace, "landing-page", "src"), { recursive: true });
fs.writeFileSync(path.join(workspace, "notes.txt"), "hello from the workspace");
process.env.EXECUTOR_WORKDIR = workspace;

// Stops a real editor window opening for every case that reaches VS Code.
process.env.EXECUTOR_VSCODE_BIN = "cmd /c echo";

// One scripted assistant reply is consumed per generateAIReply call.
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
      // Prefixed onto every open_app launch, so it is echoed rather than a
      // browser or terminal window opening for each case.
      EXECUTOR_APP_LAUNCH_PREFIX: "cmd /c echo",
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

  // Best effort. A job the suite started may still be holding the workspace as
  // its working directory, and Windows refuses to remove a directory while any
  // process is sitting in it. It is under the temp directory, so leaving it is
  // harmless - failing the run over tidying up would not be.
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch (error) {
    console.log(`[test] left ${workspace} behind: ${error.code}`);
  }
});

// Responses are SSML now, so the spoken words have to be unwrapped before they
// can be compared to anything. `ssml` keeps the raw document for the cases that
// care about the markup itself.
const spokenFrom = (body) => {
  const ssml = body.response.outputSpeech.ssml ?? "";

  return {
    type: body.response.outputSpeech.type,
    ssml,
    text: ssml
      .replace(/^<speak>/, "")
      .replace(/<\/speak>$/, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim(),
    reprompt: body.response.reprompt?.outputSpeech?.ssml ?? null,
    end: body.response.shouldEndSession,
  };
};

const post = async (sessionId, request) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: { sessionId }, request }),
  });

  return spokenFrom(await res.json());
};

const say = (sessionId, text) =>
  post(sessionId, { type: "IntentRequest", intent: { slots: { q: { value: text } } } });

// Built-in intents carry a name and no slots, which is exactly the shape that
// used to fall through to the "say tell me" message.
const sayIntent = (sessionId, intentName, slots) =>
  post(sessionId, {
    type: "IntentRequest",
    intent: { name: intentName, ...(slots ? { slots } : {}) },
  });

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

// --- autonomy: nothing waits for a spoken yes -----------------------------

test("a command that changes the repo runs without being confirmed", async () => {
  scripted.push(shell("git status --short"));
  scripted.push({ role: "assistant", content: "Committed." });
  const r = await say("s1", "commit my work");

  // The old behaviour was to hold this and read it back. Nothing does now.
  assert.doesNotMatch(r.text, /say yes|confirm/i);
  assert.equal(r.text, "Committed.");
  assert.equal(r.end, false);
});

test("no reply ever asks the user to confirm a command", async () => {
  scripted.push(shell("npm run build"));
  scripted.push({ role: "assistant", content: "Building now." });
  const r = await say("s2", "build it");

  assert.doesNotMatch(r.text, /say yes|shall i|would you like|confirm/i);
});

test("a chained command is still refused outright", async () => {
  scripted.push(shell("git status && rm -rf ."));
  scripted.push({ role: "assistant", content: "I can't run that." });
  const r = await say("s3", "run something sneaky");
  assert.equal(r.text, "I can't run that.");
});

test("a read-only command still answers inline", async () => {
  scripted.push(shell("git status"));
  scripted.push({ role: "assistant", content: "You have four modified files." });
  const r = await say("s4", "what's my git status");
  assert.equal(r.text, "You have four modified files.");
});

// --- the dedicated Claude tool -------------------------------------------

test("a Claude run starts immediately instead of reading the prompt back", async () => {
  scripted.push(toolCall("run_claude", { prompt: "build a landing page" }));
  scripted.push({ role: "assistant", content: "Building the landing page now." });
  const r = await say("c1", "build me a landing page");

  assert.doesNotMatch(r.text, /say yes|confirm/i);

  // The stand-in is node -p, so the prompt is not valid input and comes back a
  // failure. That it ran at all is the point: no refusal, and no question.
  assert.doesNotMatch(r.text, /not on the allowed list|not confirmed/);
});

test("the Claude handler no longer refuses an unconfirmed call", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "run_claude", arguments: JSON.stringify({ prompt: "1+1" }) } },
    { sessionKey: "direct" },
  );

  // It may fail for its own reasons - the stand-in, the workspace - but never
  // because nobody said yes.
  assert.doesNotMatch(String(result.error ?? ""), /not confirmed/);
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

// --- open_app ------------------------------------------------------------

const openApp = async (app) => {
  const { runTool } = await import("../src/tools/registry.js");

  return runTool({ function: { name: "open_app", arguments: JSON.stringify({ app }) } }, {});
};

test("open_app reaches a real handler for chrome and the terminal", async () => {
  for (const app of ["chrome", "browser", "terminal", "Chrome"]) {
    const result = await openApp(app);

    assert.equal(result.ok, true, `${app}: ${JSON.stringify(result)}`);
  }
});

test("open_app refuses anything without a handler, VS Code included", async () => {
  for (const app of ["spotify", "explorer", "vscode", "vs code", "cmd", "notepad.exe"]) {
    const result = await openApp(app);

    assert.equal(result.ok, false, app);
    assert.match(result.error, /don't know how to open/);
  }
});

test("the executor launches only from its own table", async () => {
  // Straight at the executor, past the Node side: a command it has no
  // launcher for is refused, not run.
  const res = await fetch(process.env.EXECUTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Executor-Secret": SECRET },
    body: JSON.stringify({ command: "open_spotify" }),
  });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unknown command/);
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

test("a missing project is created and initialised without being asked about", async () => {
  scripted.push(toolCall("init_project", { project: "invoice tracker" }));
  scripted.push({ role: "assistant", content: "Setting up invoice tracker now." });
  const r = await say("v2", "invoice tracker");

  assert.doesNotMatch(r.text, /should i|say yes/i);
  assert.ok(fs.existsSync(path.join(workspace, "invoice-tracker", ".git")));
  assert.equal(r.end, false);
});

test("the init handler no longer refuses an unconfirmed call", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "init_project", arguments: JSON.stringify({ project: "straight through" }) } },
    {},
  );

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(workspace, "straight-through", ".git")));
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

test("a run of fallbacks escalates instead of repeating one line", async () => {
  const first = await sayIntent("b4b", "AMAZON.FallbackIntent");
  const second = await sayIntent("b4b", "AMAZON.FallbackIntent");
  const third = await sayIntent("b4b", "AMAZON.FallbackIntent");

  // Asserted on the mechanism rather than the words, so rewording the spoken
  // copy does not fail the test: the second reply has to differ from the
  // first, and then stay put. Repeating one useless line is the complaint.
  assert.notEqual(second.text, first.text);
  assert.equal(third.text, second.text);
  assert.ok(second.text.length > 0);
  assert.equal(second.end, false);
});

test("one understood utterance clears the streak", async () => {
  // What a first fallback sounds like, from a session with no history.
  const { text: firstTimeText } = await sayIntent("b4d", "AMAZON.FallbackIntent");

  await sayIntent("b4c", "AMAZON.FallbackIntent");
  const escalated = await sayIntent("b4c", "AMAZON.FallbackIntent");
  assert.notEqual(escalated.text, firstTimeText);

  scripted.push({ role: "assistant", content: "Understood." });
  const good = await sayIntent("b4c", "AskIntent", { query: { name: "query", value: "what day is it" } });
  assert.equal(good.text, "Understood.");

  // Back to the first-time wording, which is what a cleared streak means.
  const afterwards = await sayIntent("b4c", "AMAZON.FallbackIntent");
  assert.equal(afterwards.text, firstTimeText);
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

test("a carrier phrase does not stop the invocation name ending the session", async () => {
  const r = await sayIntent("b7", "AskIntent", { query: { name: "query", value: "Pluto, stop" } });

  assert.equal(r.end, true);
});

test("a carrier phrase on a real question is still passed to the model", async () => {
  scripted.push({ role: "assistant", content: "It is Tuesday." });
  const r = await sayIntent("b8", "AskIntent", { query: { name: "query", value: "tell me what day it is" } });

  assert.equal(r.end, false);
  assert.equal(r.text, "It is Tuesday.");
});

// --- the autonomy instruction --------------------------------------------

test("the appended instruction is never spoken to the user", async () => {
  const { AUTONOMOUS_SUFFIX } = await import("../src/data/chatMemory.js");

  scripted.push(toolCall("run_claude", { prompt: `build a landing page

${AUTONOMOUS_SUFFIX}` }));
  scripted.push({ role: "assistant", content: "Building it now." });
  const r = await say("a1", "build me a landing page");

  assert.doesNotMatch(r.text, /autonomous developer/);
  assert.doesNotMatch(r.reprompt ?? "", /autonomous developer/);
});

test("the system prompt carries the rule and the exact wording", async () => {
  const { SYSTEM_PROMPT, AUTONOMOUS_SUFFIX } = await import("../src/data/chatMemory.js");

  assert.match(SYSTEM_PROMPT, /run_claude/);
  assert.ok(SYSTEM_PROMPT.includes(AUTONOMOUS_SUFFIX));
});

test("the system prompt tells the model to act rather than ask", async () => {
  const { SYSTEM_PROMPT } = await import("../src/data/chatMemory.js");

  assert.match(SYSTEM_PROMPT, /do not ask for permission/i);
  assert.match(SYSTEM_PROMPT, /interjection/);
  assert.match(SYSTEM_PROMPT, /Pluto/);
});

// --- reading a file ------------------------------------------------------

test("type is on the allowlist and reads a workspace file", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const call = { function: { name: "run_command", arguments: JSON.stringify({ command: "type notes.txt" }) } };

  const result = await runTool(call, {});

  assert.equal(result.ok, true);
  assert.match(result.output, /hello from the workspace/);
});

test("a relative read resolves inside the workspace, not the repo", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "run_command", arguments: JSON.stringify({ command: "type package.json" }) } },
    {},
  );

  // package.json exists in the repo but not in the workspace, which is what
  // proves the read happened in the workspace.
  assert.match(result.output, /cannot find|not find the file/i);
});

// --- the project working directory, at the executor -----------------------

const executorPost = async (command, args) => {
  const res = await fetch(process.env.EXECUTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Executor-Secret": SECRET },
    body: JSON.stringify({ command, args }),
  });

  return { status: res.status, body: await res.json() };
};

test("a cwd naming a real project is used for the run", async () => {
  const { body } = await executorPost("start_claude", { prompt: "1+1", cwd: "landing page" });

  assert.equal(body.ok, true);
  assert.equal(body.cwd, path.join(workspace, "landing-page"));
});

test("a nested cwd resolves under the project", async () => {
  const { body } = await executorPost("start_claude", { prompt: "1+1", cwd: "landing-page/src" });

  assert.equal(body.cwd, path.join(workspace, "landing-page", "src"));
});

test("a cwd that does not exist is refused rather than created", async () => {
  const { body } = await executorPost("start_claude", { prompt: "1+1", cwd: "invented project" });

  assert.equal(body.ok, false);
  assert.match(body.error, /no 'invented project'/);
  assert.ok(!fs.existsSync(path.join(workspace, "invented-project")));
});

test("a cwd cannot escape the workspace", async () => {
  const { body } = await executorPost("start_claude", {
    prompt: "1+1",
    cwd: "../../Windows/System32",
  });

  // Slugified into harmless nonsense inside the workspace, which then does not
  // exist - so it is refused rather than run anywhere.
  assert.equal(body.ok, false);
  assert.match(body.error, /workspace/);
});

// --- confinement, through the whole path ---------------------------------

test("an absolute path is refused, not read", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "run_command", arguments: JSON.stringify({ command: "type C:/projects/jarvis/jarvis/.env" }) } },
    {},
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /outside the project workspace/);
  // The point of the rule: no part of the file comes back.
  assert.ok(!("output" in result));
});

test("a traversal out of the workspace is refused", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "run_command", arguments: JSON.stringify({ command: "type ../../.env" }) } },
    {},
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /outside the project workspace/);
});

test("an escaping command is refused even though nothing is gated any more", async () => {
  scripted.push(toolCall("run_command", { command: "git add C:/projects/jarvis/jarvis/.env" }));
  scripted.push({ role: "assistant", content: "I can't reach that." });
  const r = await say("cf1", "stage that file");

  assert.equal(r.text, "I can't reach that.");
});

test("the executor refuses it too, with no Node allowlist in the path", async () => {
  const { body, status } = await executorPost("run_command", {
    command: "type C:/projects/jarvis/jarvis/.env",
  });

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /outside the workspace/);
});

test("relative work inside the workspace is untouched by all of this", async () => {
  const { runTool } = await import("../src/tools/registry.js");
  const result = await runTool(
    { function: { name: "run_command", arguments: JSON.stringify({ command: "type notes.txt" }) } },
    {},
  );

  assert.equal(result.ok, true);
  assert.match(result.output, /hello from the workspace/);
});

// --- exiting -------------------------------------------------------------

test("exit pluto ends the session", async () => {
  const r = await sayIntent("x1", "AskIntent", { query: { name: "query", value: "exit pluto" } });

  assert.equal(r.end, true);
});

test("the invocation name works as a carrier, which the fallback advice relies on", async () => {
  // The escalation line tells the user to say "Pluto, followed by your
  // command", so "Pluto, stop" has to reach the exit list.
  const r = await sayIntent("x2", "AskIntent", { query: { name: "query", value: "Pluto, stop" } });

  assert.equal(r.end, true);
});

test("pluto in front of a real question still reaches the model", async () => {
  scripted.push({ role: "assistant", content: "It is Wednesday." });
  const r = await sayIntent("x3", "AskIntent", { query: { name: "query", value: "pluto what day is it" } });

  assert.equal(r.end, false);
  assert.equal(r.text, "It is Wednesday.");
});

// --- what every response carries -----------------------------------------

test("responses are SSML, not PlainText", async () => {
  scripted.push({ role: "assistant", content: "Sure thing." });
  const r = await say("ssml1", "hello");

  // PlainText would have read any interjection out as words.
  assert.equal(r.type, "SSML");
  assert.ok(r.ssml.startsWith("<speak>"), r.ssml);
});

test("an interjection from the model reaches Alexa as markup", async () => {
  scripted.push({
    role: "assistant",
    content: '<say-as interpret-as="interjection">got it</say-as> starting the server.',
  });
  const r = await say("ssml2", "run my project");

  assert.match(r.ssml, /<say-as interpret-as="interjection">got it<\/say-as>/);
});

test("tool output with an ampersand does not produce an invalid document", async () => {
  scripted.push({ role: "assistant", content: "I ran lint && test, both passed." });
  const r = await say("ssml3", "how did it go");

  assert.ok(!/&(?!amp;|lt;|gt;)/.test(r.ssml), r.ssml);
});

test("every mic-open response carries a reprompt", async () => {
  scripted.push({ role: "assistant", content: "Still here." });

  const answers = [
    await say("rp1", "anything"),
    await sayIntent("rp2", "AMAZON.HelpIntent"),
    await sayIntent("rp3", "AMAZON.FallbackIntent"),
    await post("rp4", { type: "LaunchRequest" }),
  ];

  for (const answer of answers) {
    assert.equal(answer.end, false);
    assert.ok(answer.reprompt, `no reprompt on ${answer.text}`);
    assert.ok(answer.reprompt.startsWith("<speak>"), answer.reprompt);
  }
});

test("a response that ends the session carries no reprompt", async () => {
  const r = await sayIntent("rp5", "AMAZON.StopIntent");

  assert.equal(r.end, true);
  assert.equal(r.reprompt, null);
});

test("the launch greeting is time-aware and names Pluto", async () => {
  const r = await post("rp6", { type: "LaunchRequest" });

  assert.match(r.text, /Good morning|Good afternoon|Good evening|Working late/);
  assert.match(r.text, /Pluto is here/);
  assert.equal(r.end, false);
});

test("the reprompt narrates running work, whichever session started it", async () => {
  const { clearAllJobs, registerJob } = await import("../src/data/jobRegistry.js");

  clearAllJobs();
  registerJob({
    // Deliberately not the session doing the asking: work outlives the
    // conversation that started it, and the reprompt has to say so.
    sessionKey: "some-earlier-conversation",
    label: "ask Claude to build a landing page",
    narration: "Claude is currently building a landing page",
    promise: new Promise(() => {}),
  });

  scripted.push({ role: "assistant", content: "Anything else?" });
  const busy = await say("rp7", "how's it going");

  assert.match(busy.reprompt, /Claude is currently building a landing page/);

  // ...and with nothing running at all, the plain invitation comes back.
  clearAllJobs();
  scripted.push({ role: "assistant", content: "Anything else?" });
  const idle = await say("rp8", "how's it going");

  assert.match(idle.reprompt, /let me know what to do next/i);
});

// --- work outliving the conversation -------------------------------------

test("a session ending does not throw away running work", async () => {
  const { clearAllJobs, getAllJobs, registerJob } = await import("../src/data/jobRegistry.js");

  clearAllJobs();
  registerJob({
    sessionKey: "sv1",
    label: "ask Claude to build a landing page",
    narration: "Claude is currently building a landing page",
    promise: new Promise(() => {}),
  });

  // Every way a session can end. Each one used to take the job with it, which
  // meant the result the user came back for was gone before they could ask.
  await post("sv1", { type: "SessionEndedRequest" });
  assert.equal(getAllJobs().length, 1, "SessionEndedRequest must not clear it");

  await sayIntent("sv1", "AMAZON.StopIntent");
  assert.equal(getAllJobs().length, 1, "stop must not clear it");

  await say("sv1", "exit pluto");
  assert.equal(getAllJobs().length, 1, "an exit phrase must not clear it");

  await say("sv1", "thank you");
  assert.equal(getAllJobs().length, 1, "a farewell must not clear it");

  clearAllJobs();
});

test("a finished job is reported into whatever conversation comes next", async () => {
  const { clearAllJobs, registerJob } = await import("../src/data/jobRegistry.js");

  clearAllJobs();
  registerJob({
    sessionKey: "gone-conversation",
    label: "ask Claude to build a landing page",
    promise: Promise.resolve({ ok: true, output: "created index.html" }),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  // A brand new session id, as re-opening the skill produces. The note has to
  // reach it anyway, or nothing ever tells the user their build landed.
  let seen = null;
  scripted.push({ role: "assistant", content: "Your landing page is done." });
  const r = await say("a-fresh-session", "is it done");

  seen = r.text;
  assert.equal(seen, "Your landing page is done.");
  clearAllJobs();
});

// --- handing off and closing ---------------------------------------------

test("an ordinary answer still keeps the mic open", async () => {
  scripted.push({ role: "assistant", content: "It is Thursday." });
  const r = await say("close2", "what day is it");

  assert.equal(r.end, false);
  assert.ok(r.reprompt);
});
