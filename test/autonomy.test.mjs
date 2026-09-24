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
const { confirmationFor, runTool } = await import("../src/tools/registry.js");

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

const runClaude = (prompt) => runTool(claudeCall(prompt), { confirmed: true });

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

test("the instruction is stripped from what the user is asked to confirm", () => {
  const held = confirmationFor(claudeCall(`build a landing page\n\n${AUTONOMOUS_SUFFIX}`));

  assert.equal(held.command, "Claude with: build a landing page");
  assert.doesNotMatch(held.command, /autonomous developer/);
});

test("an unconfirmed call sends nothing at all", async () => {
  started.length = 0;
  const result = await runTool(claudeCall("delete everything"), {});

  assert.equal(result.ok, false);
  assert.equal(started.length, 0);
});

// --- the project working directory ---------------------------------------

test("cwd is forwarded to the executor", async () => {
  started.length = 0;
  await runTool(claudeCallIn("add a hero section", "landing page"), { confirmed: true });

  assert.equal(started[0].cwd, "landing page");
});

test("no cwd means none is sent, so the executor keeps its default", async () => {
  started.length = 0;
  await runClaude("just answer a question");

  assert.ok(!("cwd" in started[0]));
});

test("a null cwd is treated as absent, not sent as null", async () => {
  started.length = 0;
  await runTool(claudeCallIn("add a hero section", null), { confirmed: true });

  assert.ok(!("cwd" in started[0]));
});

test("the confirmation says where the files will land", () => {
  const held = confirmationFor(claudeCallIn("add a hero section", "landing page"));

  assert.equal(held.command, "Claude with: add a hero section, in landing page");
});

test("the confirmation stays short when there is no project", () => {
  const held = confirmationFor(claudeCall("just answer a question"));

  assert.equal(held.command, "Claude with: just answer a question");
  assert.doesNotMatch(held.command, /, in /);
});
