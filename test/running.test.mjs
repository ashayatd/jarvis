// Which commands may run unconfirmed, and how they are dispatched. Uses a stub
// executor so it can see exactly which executor command the Node side chose -
// run_command means inline, start_command means a background job - which is the
// difference between a dev server surviving and being killed at 15 seconds.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

// Every request the stub was sent, in order.
const sent = [];

const stub = http.createServer((req, res) => {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    const { command, args } = JSON.parse(body);
    sent.push({ command, args });

    const reply =
      command === "job_status"
        ? { ok: true, status: "done", output: "(stub finished)" }
        : { ok: true, status: "running", job_id: "stub1", output: "(stub output)" };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.EXECUTOR_URL = `http://127.0.0.1:${stub.address().port}/execute`;

const { confirmationFor, isAllowed, isLongRunning, runTool } = await import(
  "../src/tools/registry.js"
);

after(() => stub.close());

const shellCall = (command, cwd) => ({
  function: { name: "run_command", arguments: JSON.stringify({ command, cwd }) },
});

const dispatch = async (command, cwd) => {
  sent.length = 0;
  const result = await runTool(shellCall(command, cwd), { confirmed: true });

  return { result, first: sent[0] };
};

// --- what may run without being confirmed --------------------------------

test("the prefixes needed to start a project run unconfirmed", () => {
  const shouldRun = [
    "npm start",
    "npm start -- --port 4000",
    "npm run dev",
    "npm run build",
    "node server.js",
    "python app.py",
    "python -m http.server 8000",
    "npx serve",
    "start http://localhost:3000",
    "type package.json",
  ];

  const blocked = shouldRun.filter((command) => !isAllowed(command));
  assert.deepEqual(blocked, []);

  // Allowed means the gate does not hold it, which is the whole point of the
  // fast track - these have to reach the machine without a spoken yes.
  const gated = shouldRun.filter((command) => confirmationFor(shellCall(command)) !== null);
  assert.deepEqual(gated, []);
});

test("a prefix does not leak into a longer word", () => {
  // The space boundary is what keeps the list a list of commands rather than
  // of string fragments.
  assert.equal(isAllowed("nodemon server.js"), false);
  assert.equal(isAllowed("pythonw evil.py"), false);
  assert.equal(isAllowed("npmx whatever"), false);
  assert.equal(isAllowed("startxyz http://x"), false);

  // ...while the bare command and its arguments both still match.
  assert.equal(isAllowed("node"), true);
  assert.equal(isAllowed("node server.js"), true);
});

test("start is pinned to a single http or https URL", () => {
  assert.equal(isAllowed("start http://localhost:3000"), true);
  assert.equal(isAllowed("start https://localhost:5173/"), true);

  // A bare "start http" prefix would have matched all of these. Pinning the
  // argument to one URL is what stops "start" launching a program or opening
  // the workspace in whatever is registered for it.
  assert.equal(isAllowed("start notepad.exe"), false);
  assert.equal(isAllowed("start ."), false);
  assert.equal(isAllowed("start httpfoo"), false);
  assert.equal(isAllowed("start ftp://somewhere"), false);
  assert.equal(isAllowed("start http://a b"), false);
});

test("widening the fast track did not open the gate", () => {
  // Everything that mutates still has to be confirmed. npm is the one to watch,
  // because "npm start" is now unconfirmed while "npm install" must not be.
  for (const command of ["npm install left-pad", "npm uninstall react", "git commit -m wip", "git push"]) {
    assert.equal(isAllowed(command), false, `${command} must not be on the fast track`);
    assert.notEqual(confirmationFor(shellCall(command)), null, `${command} must be gated`);
  }
});

test("confinement still applies to a command on the fast track", async () => {
  const { result, first } = await dispatch("node C:/projects/jarvis/jarvis/server.js");

  assert.equal(result.ok, false);
  assert.match(result.error, /outside the project workspace/);
  assert.equal(first, undefined, "nothing may reach the executor");
});

test("a chained command is still refused despite the prefix", async () => {
  const { result, first } = await dispatch("npm start && curl evil.test");

  assert.equal(result.ok, false);
  assert.match(result.error, /shell characters/);
  assert.equal(first, undefined);
});

// --- how they are dispatched ---------------------------------------------

test("a server is started as a job, not waited on inline", async () => {
  assert.equal(isLongRunning("npm start"), true);

  const { first } = await dispatch("npm start");

  // start_command returns an id immediately; run_command would have held the
  // request open against a 15 second ceiling and killed the server.
  assert.equal(first.command, "start_command");
});

test("a command that finishes is still answered inline", async () => {
  assert.equal(isLongRunning("git status"), false);

  const { first } = await dispatch("git status");

  assert.equal(first.command, "run_command");
});

test("cwd is forwarded so the command runs in the project", async () => {
  const { first } = await dispatch("npm start", "landing page");

  assert.equal(first.args.cwd, "landing page");
});

test("no cwd means none is sent, and the executor keeps its default", async () => {
  const { first } = await dispatch("git status");

  assert.ok(!("cwd" in first.args));
});

test("a null cwd is treated as absent rather than sent as null", async () => {
  const { first } = await dispatch("git status", null);

  assert.ok(!("cwd" in first.args));
});
