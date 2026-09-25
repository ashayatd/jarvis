// What the Node side actually hands the executor for a run_claude call. Lives
// in its own file because EXECUTOR_URL is read once when executorService.js is
// imported, so pointing it at a stub has to happen before any import - and the
// test runner gives each file its own process.
//
// No python here: the stub stands in for executor.py so these assertions are
// about the prompt, not about the CLI.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

// Every start_claude body the stub was sent, in order.
const started = [];

const stub = http.createServer((req, res) => {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    const { command, args } = JSON.parse(body);

    if (command === "start_claude") {
      started.push(args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "running", job_id: "stub1" }));
      return;
    }

    if (command === "job_status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "done", output: "(stub finished)" }));
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `unexpected command ${command}` }));
  });
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.EXECUTOR_URL = `http://127.0.0.1:${stub.address().port}/execute`;

const { AUTONOMOUS_SUFFIX } = await import("../src/data/chatMemory.js");
const { narrateToolCall, runTool } = await import("../src/tools/registry.js");

before(() => {
  started.length = 0;
});

after(() => stub.close());

const claudeCall = (prompt) => ({
  function: { name: "run_claude", arguments: JSON.stringify({ prompt }) },
});

const claudeCallIn = (prompt, cwd) => ({
  function: { name: "run_claude", arguments: JSON.stringify({ prompt, cwd }) },
});

const runClaude = (prompt) => runTool(claudeCall(prompt), {});

const countSuffix = (prompt) =>
  prompt.split(AUTONOMOUS_SUFFIX).length - 1;

test("the instruction is appended when the model forgot it", async () => {
  started.length = 0;
  const result = await runClaude("build a landing page");

  assert.equal(result.ok, true);
  assert.equal(started.length, 1);
  assert.equal(countSuffix(started[0].prompt), 1);
  assert.match(started[0].prompt, /^build a landing page/);
});

test("it is appended once when the model did remember", async () => {
  started.length = 0;
  await runClaude(`build a landing page\n\n${AUTONOMOUS_SUFFIX}`);

  assert.equal(countSuffix(started[0].prompt), 1);
});

test("the user's own wording is never dropped or reordered", async () => {
  started.length = 0;
  await runClaude("add a dark mode toggle to the settings page");

  assert.ok(started[0].prompt.startsWith("add a dark mode toggle to the settings page"));
  assert.ok(started[0].prompt.endsWith(AUTONOMOUS_SUFFIX));
});

test("a prompt full of shell metacharacters is passed through untouched", async () => {
  started.length = 0;
  const awkward = 'fix the bug in parse($input) && report it > log.txt';
  await runClaude(awkward);

  assert.ok(started[0].prompt.includes(awkward));
});

test("the instruction is stripped from what the reprompt narrates", () => {
  // It used to be stripped from the confirmation. The confirmation is gone, but
  // the reprompt now says the prompt out loud every time the user goes quiet,
  // so the boilerplate still has to come off.
  const narration = narrateToolCall("run_claude", {
    prompt: `build a landing page\n\n${AUTONOMOUS_SUFFIX}`,
  });

  assert.equal(narration, "Claude is currently building build a landing page");
  assert.doesNotMatch(narration, /autonomous developer/);
});

test("a call with no prompt sends nothing at all", async () => {
  started.length = 0;
  const result = await runTool(claudeCall(""), {});

  assert.equal(result.ok, false);
  assert.equal(started.length, 0);
});

test("a call runs without any confirmation being passed", async () => {
  started.length = 0;
  const result = await runTool(claudeCall("build something"), {});

  assert.equal(result.ok, true);
  assert.equal(started.length, 1);
  assert.doesNotMatch(String(result.error ?? ""), /not confirmed/);
});

// --- the project working directory ---------------------------------------

test("cwd is forwarded to the executor", async () => {
  started.length = 0;
  await runTool(claudeCallIn("add a hero section", "landing page"), {});

  assert.equal(started[0].cwd, "landing page");
});

test("no cwd means none is sent, so the executor keeps its default", async () => {
  started.length = 0;
  await runClaude("just answer a question");

  assert.ok(!("cwd" in started[0]));
});

test("a null cwd is treated as absent, not sent as null", async () => {
  started.length = 0;
  await runTool(claudeCallIn("add a hero section", null), {});

  assert.ok(!("cwd" in started[0]));
});

test("the narration says where the work is happening", () => {
  const narration = narrateToolCall("run_claude", {
    prompt: "add a hero section",
    cwd: "landing page",
  });

  assert.equal(narration, "Claude is currently building add a hero section in landing page");
});

test("the narration stays short when there is no project", () => {
  const narration = narrateToolCall("run_claude", { prompt: "just answer a question" });

  assert.equal(narration, "Claude is currently building just answer a question");
  assert.doesNotMatch(narration, / in /);
});

test("a tool with nothing to narrate returns nothing", () => {
  assert.equal(narrateToolCall("check_background_jobs", {}), null);
  assert.equal(narrateToolCall("no_such_tool", {}), null);
});
