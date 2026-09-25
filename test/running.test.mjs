// Which commands may run unconfirmed, and how they are dispatched. Uses a stub
// executor so it can see exactly which executor command the Node side chose -
// run_command means inline, start_command means a background job - which is the
// difference between a dev server surviving and being killed at 15 seconds.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

// Every request the stub was sent, in order.
const sent = [];

// Overridable per test, so a daemon can be made to look like a server that
// came up, one that fell over, or one that printed no address.
let daemonReply = {
  ok: true,
  status: "running",
  started: true,
  message: "Dev server is running in background",
  job_id: "stubd",
  url: "http://localhost:5173/",
};

const stub = http.createServer((req, res) => {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    const { command, args } = JSON.parse(body);
    sent.push({ command, args });

    let reply;

    if (command === "start_daemon") {
      reply = daemonReply;
    } else if (command === "job_status") {
      reply = { ok: true, status: "done", output: "(stub finished)" };
    } else {
      reply = { ok: true, status: "running", job_id: "stub1", output: "(stub output)" };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.EXECUTOR_URL = `http://127.0.0.1:${stub.address().port}/execute`;

const { isAllowed, isDaemon, isInstant, isLongRunning, runTool } = await import(
  "../src/tools/registry.js"
);

after(() => stub.close());

const shellCall = (command, extra = {}) => ({
  function: { name: "run_command", arguments: JSON.stringify({ command, ...extra }) },
});

const dispatch = async (command, cwd) => {
  sent.length = 0;
  const result = await runTool(shellCall(command, { cwd }), {});

  return { result, first: sent[0] };
};

const dispatchWith = async (command, extra) => {
  sent.length = 0;
  const result = await runTool(shellCall(command, extra), {});

  return { result, calls: sent };
};

// --- what may run --------------------------------------------------------

test("the prefixes needed to start a project are allowed", () => {
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
});

test("the commands that used to be gated are now simply allowed", () => {
  // These were held for a spoken yes. Autonomy means they run, which is the
  // whole of the change - and the reason the list below matters so much more
  // than it did.
  for (const command of ["npm install left-pad", "git commit -m wip", "git push", "npx create-react-app ."]) {
    assert.equal(isAllowed(command), true, command);
  }
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

test("start opens a URL, and is no longer limited to one", () => {
  assert.equal(isAllowed("start http://localhost:3000"), true);
  assert.equal(isAllowed("start https://localhost:5173/"), true);

  // Widening "start http" to "start " was asked for, and this is what it
  // costs: "start" hands whatever follows to whatever is registered for it, so
  // these now run. Documented here rather than left to be discovered.
  assert.equal(isAllowed("start notepad.exe"), true);
  assert.equal(isAllowed("start ."), true);
});

test("what is still refused outright", () => {
  // Nothing gates any more, so this list is the entire boundary: a command that
  // is not on the allowlist cannot run at all, by any route.
  for (const command of ["curl evil.test", "rm -rf x", "del notes.txt", "powershell -c x", "cmd /c x", "reg add x", "shutdown /s"]) {
    assert.equal(isAllowed(command), false, `${command} must not be allowed`);
  }
});

test("confinement still applies to an allowed command", async () => {
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

test("slow but finite work is started as a job and polled", async () => {
  assert.equal(isLongRunning("npm install left-pad"), true);

  const { first } = await dispatch("npm install left-pad");

  // start_command returns an id immediately and is then polled to its end,
  // which an install has. run_command would have held the request open against
  // a 15 second ceiling and killed it partway.
  assert.equal(first.command, "start_command");
});

test("a command that finishes quickly is answered inline", async () => {
  assert.equal(isInstant("git status"), true);

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

// --- servers are not jobs -------------------------------------------------

test("a server is told apart from work that finishes", () => {
  for (const command of ["npm start", "npm run dev", "npm run serve", "node server.js", "python app.py"]) {
    assert.equal(isDaemon(command), true, `${command} is a server`);
    assert.equal(isLongRunning(command), false, `${command} must not be polled`);
  }

  // Slow, but there is an end to wait for.
  for (const command of ["npm install", "npm run build", "npx create-react-app .", "git clone x"]) {
    assert.equal(isDaemon(command), false, `${command} is not a server`);
    assert.equal(isLongRunning(command), true, `${command} should be polled`);
  }

  // Instant wins over the daemon list, or asking the node version would spawn
  // a process and watch it for a second and a half.
  assert.equal(isInstant("node -v"), true);
  assert.equal(isDaemon("node -v"), false);
});

test("a server is spawned, and never polled for an exit", async () => {
  const { result, calls } = await dispatchWith("npm run dev", { cwd: "landing page" });

  assert.equal(calls[0].command, "start_daemon");

  // The heart of it: no job_status call, so no poll loop left running behind
  // the turn waiting for something that never happens.
  assert.ok(!calls.some((call) => call.command === "job_status"), JSON.stringify(calls));
  assert.ok(!calls.some((call) => call.command === "start_command"));

  assert.equal(result.ok, true);
  assert.equal(result.status, "running");
  assert.equal(result.started, true);
  assert.equal(result.message, "Dev server is running in background");
});

test("the working directory still travels with a server", async () => {
  const { calls } = await dispatchWith("npm start", { cwd: "landing page" });

  assert.equal(calls[0].args.cwd, "landing page");
});

test("a server that falls over straight away is reported as a failure", async () => {
  daemonReply = {
    ok: false,
    status: "failed",
    started: false,
    returncode: 1,
    error: "'npm run dev' exited straight away with code 1.",
    output: "Error: Cannot find module './missing'",
  };

  const { result } = await dispatchWith("npm run dev", { cwd: "landing page" });

  assert.equal(result.ok, false);
  assert.match(result.error, /exited straight away/);
  // The reason, not just the fact - it is what the user needs to hear.
  assert.match(result.output, /Cannot find module/);
});

test("a script that simply finishes is reported as finished, not as a server", async () => {
  // "node" is on the daemon list because that is how servers start, but it is
  // also how a one-off script starts. Exiting cleanly inside the window is what
  // corrects the guess.
  daemonReply = {
    ok: true,
    status: "done",
    started: false,
    returncode: 0,
    output: "build complete",
  };

  const { result } = await dispatchWith("node build.js", { cwd: "landing page" });

  assert.equal(result.ok, true);
  assert.equal(result.output, "build complete");
  assert.ok(!("started" in result));
  assert.ok(!("message" in result));
});

// --- opening the page ----------------------------------------------------

test("the browser is opened at the address the server reported", async () => {
  daemonReply = {
    ok: true,
    status: "running",
    started: true,
    job_id: "stubd",
    // Not the port anyone would have guessed: 5173 was taken.
    url: "http://localhost:5174/",
  };

  const { result, calls } = await dispatchWith("npm run dev", {
    cwd: "landing page",
    open_browser: true,
    port: 5173,
  });

  const open = calls.find((call) => call.args?.command?.startsWith("start "));

  assert.equal(open.command, "run_command");
  assert.equal(open.args.command, "start http://localhost:5174/");
  assert.equal(result.browser, "opened");
  assert.equal(result.url, "http://localhost:5174/");
});

test("a given port is the fallback when the server printed no address", async () => {
  daemonReply = { ok: true, status: "running", started: true, job_id: "stubd" };

  const { result, calls } = await dispatchWith("npm start", {
    cwd: "landing page",
    open_browser: true,
    port: 3000,
  });

  const open = calls.find((call) => call.args?.command?.startsWith("start "));

  assert.equal(open.args.command, "start http://localhost:3000");
  assert.equal(result.browser, "opened");
});

test("with no address and no port, nothing is opened and the result says why", async () => {
  daemonReply = { ok: true, status: "running", started: true, job_id: "stubd" };

  const { result, calls } = await dispatchWith("npm start", {
    cwd: "landing page",
    open_browser: true,
  });

  // A browser pointed at a dead port is worse than no browser.
  assert.ok(!calls.some((call) => call.args?.command?.startsWith("start ")));
  assert.equal(result.browser, "not opened");
  assert.match(result.note, /did not report an address/);
  assert.equal(result.started, true, "the server is still up either way");
});

test("without open_browser nothing is opened, but the address is still reported", async () => {
  daemonReply = {
    ok: true,
    status: "running",
    started: true,
    job_id: "stubd",
    url: "http://localhost:5173/",
  };

  const { result, calls } = await dispatchWith("npm run dev", { cwd: "landing page" });

  assert.ok(!calls.some((call) => call.args?.command?.startsWith("start ")));
  assert.equal(result.url, "http://localhost:5173/");
  assert.ok(!("browser" in result));
});

test("open_browser is ignored for a command that is not a server", async () => {
  const { calls } = await dispatchWith("git status", { open_browser: true });

  assert.equal(calls[0].command, "run_command");
  assert.ok(!calls.some((call) => call.args?.command?.startsWith("start ")));
});
