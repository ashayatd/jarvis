import { AUTONOMOUS_SUFFIX } from "../data/chatMemory.js";
import {
  describeJob,
  forgetDaemon,
  getAllDaemons,
  getAllJobs,
  getSessionDaemons,
  registerDaemon,
} from "../data/jobRegistry.js";
import {
  execute,
  INLINE_TIMEOUT_MS,
  REMOTE_JOB_TIMEOUT_MS,
} from "../services/executorService.js";
import { log, logError, logWarn, preview, startTimer } from "../utils/logger.js";

// Spoken app names -> the command your PC agent actually receives. None of
// these have handlers on the agent yet; they need adding there before they
// will work.
//
// VS Code is deliberately absent. It is opened through open_project, which
// needs a project name, so there is no tool that can drop the user into the
// workspace root - which is what makes step one of the workflow structural
// rather than something the prompt has to be trusted to remember.
const APP_COMMANDS = {
  "chrome": "open_chrome",
  "browser": "open_chrome",
  "terminal": "open_terminal",
  "explorer": "open_explorer",
  "file explorer": "open_explorer",
  "spotify": "open_spotify",
};

// Everything run_command may run, and all of it runs immediately - there is no
// confirmation step any more. Matched on a prefix with a space boundary, so an
// entry permits its own arguments ("npm" covers "npm run build") but never a
// longer word ("node" does not match "nodemon"). An entry is therefore a
// promise about everything that can follow it.
//
// This list is now the only thing deciding what may run, so read it as the
// answer to "what can Pluto do to this machine". Two rules still apply to every
// command below, and they are what keeps the list honest: no shell
// metacharacters, so nothing can be chained, and no absolute path or "..", so
// nothing outside the workspace can be named.
//
// "start" and "npx" would be the widest entries by a distance - "start"
// launches whatever is registered for what follows it, and "npx" fetches and
// runs code from the registry. Both are narrowed by what may follow them; see
// ARGUMENT_RULES below.
const ALLOWED_PREFIXES = [
  // Reading the workspace and the machine. Relative paths only - an absolute
  // one is rejected before this is reached.
  "dir",
  "ls",
  "type",
  "whoami",
  "date",
  // Running a project, whatever it happens to be built with, and opening it.
  "node",
  "python",
  "npx",
  "start",
  // The repo and its packages. These change things - they were held for a
  // spoken yes until autonomy replaced the gate.
  "git",
  "npm",
];

// Servers. These never exit, so there is nothing to wait for and polling one to
// completion is a category error: the poll runs until it gives up, the executor
// kills the process at its job timeout, and the user is told their dev server
// timed out. They are spawned, checked once to see they did not fall over, and
// then left alone.
//
// "node" and "python" are here because that is how a server is usually started,
// but they are also how a one-off script is started. That is fine: a script
// exits inside the confirmation window and is reported as the finished command
// it is, so the misclassification corrects itself.
const DAEMON_PREFIXES = [
  "npm start",
  "npm run dev",
  "npm run start",
  "npm run serve",
  "npm run preview",
  "npm run watch",
  "node",
  "python",
];

// Commands that finish in a moment and can be answered inline. Everything else
// allowed is treated as long-running and sent down the job path instead,
// because inline means the executor's 15 second ceiling - which would kill a
// slow install just as it got going and report it as a timeout.
//
// Stated as the short list rather than the long one so a new entry above is
// slow by default: waiting a little too long for an answer is a much smaller
// problem than work killed halfway and reported as a failure.
const INSTANT_PREFIXES = [
  "git status",
  "git log",
  "git branch",
  "git diff",
  "git remote",
  "dir",
  "ls",
  "type",
  "whoami",
  "date",
  "node -v",
  "npm -v",
  // Launching the browser hands off and returns; it does not wait for the page.
  "start",
];

const matchesPrefix = (command, prefixes) => {
  const normalized = command.trim().toLowerCase();

  return prefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
};

// Kept only to name the commands that change something, for the tool
// description. Nothing gates on it any more: these run like anything else.
export const MUTATING_PREFIXES = ["git ", "npm ", "npx ", "claude "];

// Chaining defeats prefix matching on its own: "git status && rm -rf ."
// starts with an allowed prefix. Reject anything that could begin a second
// command before either the allowlist or the confirmation gate runs.
const SHELL_METACHARACTERS = /[;&|<>`$()\x00-\x1f]/;

const hasShellMetacharacters = (command) => SHELL_METACHARACTERS.test(command);

// Confinement, not sandboxing. The executor already runs every command with
// the workspace as its cwd, so a relative path cannot leave it - these reject
// the ways a command can name somewhere else outright. It matters because this
// service is reachable through the tunnel and "type" reads files: without it,
// "type C:\Users\me\projects\jarvis\.env" hands over the Groq key.
//
// A token starting with a drive letter and colon ("C:\", "C:/", "C:foo") or
// with a backslash ("\Windows", "\\server\share") is an absolute path.
const ABSOLUTE_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:|\\)/;

// Anywhere, not only at a token start: "notes/../../secrets" climbs out from
// the middle. The casualty is a git revision range like "main..HEAD", which is
// a fair trade for a rule with no gaps in it.
const TRAVERSAL = /\.\./;

// Exported so the rule itself can be tested against a table of commands,
// rather than only through whatever a tool happens to do with it.
export const escapesWorkspace = (command) =>
  ABSOLUTE_PATH.test(command) || TRAVERSAL.test(command);

// "npx" and "start" were the two entries whose prefix promised the most - npx
// runs any package from the registry, start runs whatever is registered for
// what follows it. Each is narrowed here to what is actually asked for by
// voice, by looking at what comes after the prefix.

// Scaffolders and a static server. Anything else from the registry is refused.
export const NPX_PACKAGES = ["create-vite", "create-next-app", "create-react-app", "serve"];

// Only the flag that skips npx's install prompt, which would otherwise hang a
// run with no stdin. Every other flag is refused rather than parsed: "-p evil"
// and "--package=evil" install a package that is not the one named.
const NPX_FLAGS = new Set(["-y", "--yes"]);

// The package name, with an optional version or tag: create-vite@latest.
const NPX_PACKAGE = /^([a-z0-9][a-z0-9._-]*)(?:@[a-z0-9.^~*-]+)?$/;

const npxPackageAllowed = (rest) => {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const first = tokens.findIndex((token) => !NPX_FLAGS.has(token));

  if (first === -1 || tokens.slice(0, first).some((token) => !NPX_FLAGS.has(token))) {
    return false;
  }

  const match = NPX_PACKAGE.exec(tokens[first]);

  return Boolean(match) && NPX_PACKAGES.includes(match[1]);
};

// Browsers and notepad, by name. VS Code is still absent for the reason given
// above APP_COMMANDS.
export const START_APPS = ["chrome", "msedge", "firefox", "notepad"];

const WEB_URL = /^https?:\/\/[^\s"']+$/;

// "start <url>", "start <app>" or "start <app> <url>". Nothing else - not a
// file, not a folder, not a second argument.
const startTargetAllowed = (rest) => {
  const tokens = rest.split(/\s+/).filter(Boolean);

  if (tokens.length === 1) {
    return WEB_URL.test(tokens[0]) || START_APPS.includes(tokens[0]);
  }

  return tokens.length === 2 && START_APPS.includes(tokens[0]) && WEB_URL.test(tokens[1]);
};

// Keyed by the prefix they narrow. Applied after the prefix has matched.
const ARGUMENT_RULES = {
  npx: npxPackageAllowed,
  start: startTargetAllowed,
};

// Why a command that passed the prefix list was still refused, for the error
// the model reads back. Null when nothing narrowed it.
const argumentRefusal = (command) => {
  const normalized = command.trim().toLowerCase();
  const [head] = normalized.split(/\s+/);
  const rule = ARGUMENT_RULES[head];

  if (!rule || rule(normalized.slice(head.length).trim())) {
    return null;
  }

  return head === "npx"
    ? `npx may only run ${NPX_PACKAGES.join(", ")}.`
    : `start may only open an http or https address, or one of ${START_APPS.join(", ")}.`;
};

// Both exported for the same reason as escapesWorkspace: a prefix list is a
// set of promises about what may follow each entry, and that is worth asserting
// directly rather than only through whatever a tool does with the answer.
export const isAllowed = (command) =>
  matchesPrefix(command, ALLOWED_PREFIXES) && argumentRefusal(command) === null;

// Checked before the daemon list, so "node -v" answers instead of being spawned
// and watched.
export const isInstant = (command) => matchesPrefix(command, INSTANT_PREFIXES);

export const isDaemon = (command) =>
  !isInstant(command) && matchesPrefix(command, DAEMON_PREFIXES);

// Slow but finite: npm install, npx create-react-app, git clone. Worth polling,
// because there is an end to poll for.
export const isLongRunning = (command) => !isInstant(command) && !isDaemon(command);

// What to say while a job is still running, so the reprompt can narrate the
// work instead of repeating one line. Lives on the tool next to `describe` for
// the same reason: the tool knows what it is doing, the route does not.
export const narrateToolCall = (toolName, args) => {
  try {
    return TOOLS[toolName]?.narrate?.(args ?? {}) ?? null;
  } catch {
    return null;
  }
};

// The system prompt tells the model to append this itself. This is the
// backstop: a forgotten suffix would mean the CLI answers with code as text
// instead of writing files, which is too easy a way for the whole feature to
// go quiet. Idempotent, so doing it in both places appends it once.
const withAutonomy = (prompt) =>
  prompt.includes(AUTONOMOUS_SUFFIX) ? prompt : `${prompt}

${AUTONOMOUS_SUFFIX}`;

// ...and the inverse, for anything the user hears. Reading the suffix aloud
// would make every confirmation a paragraph long.
const withoutAutonomy = (prompt) => prompt.replace(AUTONOMOUS_SUFFIX, "").trim();

// Opens the page a dev server just started serving, when asked to.
//
// The address the server printed is preferred over anything the model guessed:
// a vite project moved to port 5174 because 5173 was taken will say so, and
// opening the port from package.json would show the wrong app or nothing. The
// guess is only a fallback, and if there is neither then nothing is opened and
// the result says why - a browser pointed at a dead port is worse than none.
const openIfAsked = async ({ openBrowser, port, url, timeoutMs }) => {
  if (openBrowser !== true) {
    return url ? { url } : {};
  }

  const target =
    url ?? (Number.isInteger(port) && port > 0 ? `http://localhost:${port}` : null);

  if (!target) {
    logWarn("[TOOL] open_browser asked for but no address known - not guessing");

    return {
      browser: "not opened",
      note: "The server did not report an address and no port was given, so nothing was opened. Ask the user which port, or read it from package.json.",
    };
  }

  try {
    await execute("run_command", { command: `start ${target}` }, { timeoutMs });

    log(`[TOOL] opened ${target}`);

    return { url: target, browser: "opened" };
  } catch (error) {
    // The server is up either way, which is the more important half.
    logError(`[TOOL] could not open ${target}: ${error.message}`);

    return { url: target, browser: "not opened", note: `Could not open the browser: ${error.message}` };
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The first check comes quickly so a fast command (git status) still answers
// inside Alexa's budget instead of being backgrounded by the poll interval
// alone. After that there is no hurry.
const FIRST_POLL_MS = 400;
const POLL_INTERVAL_MS = 2000;

// A confirmed command can be `claude -p "build a landing page"`, which runs
// for minutes. The executor starts it in a thread and hands back an id, so no
// single HTTP request has to stay open that long - this polls until it lands.
// The waiting happens inside the tool promise, which the job registry is
// already built to hold onto after the spoken reply has gone out.
const runRemoteJob = async (startCommand, args, label) => {
  const started = await execute(startCommand, args, { timeoutMs: INLINE_TIMEOUT_MS });
  const remoteId = started?.job_id;

  if (!remoteId) {
    return { ok: false, error: `Executor did not start "${label}".` };
  }

  log(`[TOOL] remote job ${remoteId} started for "${preview(label, 80)}"`);

  const deadline = Date.now() + REMOTE_JOB_TIMEOUT_MS;
  let wait = FIRST_POLL_MS;

  while (Date.now() < deadline) {
    await sleep(wait);
    wait = POLL_INTERVAL_MS;

    const status = await execute("job_status", { job_id: remoteId }, { timeoutMs: INLINE_TIMEOUT_MS });

    if (status?.status && status.status !== "running") {
      return status;
    }
  }

  return {
    ok: false,
    error: `"${label}" is still running after ${Math.round(REMOTE_JOB_TIMEOUT_MS / 60000)} minutes.`,
  };
};

// Schema and handler live together so adding a tool is one object in one file.
// `backgroundable: false` marks a tool that must never be turned into a job -
// reading job state has to stay instant or "is it done?" would itself queue.
const TOOLS = {
  open_app: {
    backgroundable: true,
    describe: (args) => `open ${args.app ?? "an app"}`,
    schema: {
      type: "function",
      function: {
        name: "open_app",
        description:
          "Open an application on the user's Windows PC. Use when the user asks to open, launch or start a program.",
        parameters: {
          type: "object",
          properties: {
            app: {
              type: "string",
              description: `Application to open. Known values: ${Object.keys(APP_COMMANDS).join(", ")}.`,
            },
          },
          required: ["app"],
        },
      },
    },
    handler: async ({ app }, { timeoutMs }) => {
      if (!app) {
        return { ok: false, error: "No app name given." };
      }

      const command = APP_COMMANDS[app.trim().toLowerCase()];

      if (!command) {
        return {
          ok: false,
          error: `I don't know how to open "${app}". Known apps: ${Object.keys(APP_COMMANDS).join(", ")}.`,
        };
      }

      await execute(command, {}, { timeoutMs });
      return { ok: true, opened: app };
    },
  },

  run_command: {
    backgroundable: true,
    describe: (args) => `run "${args.command ?? "a command"}"`,
    narrate: ({ command, cwd }) =>
      `${command ?? "that command"} is still running${cwd ? ` in ${cwd}` : ""}`,
    schema: {
      type: "function",
      function: {
        name: "run_command",
        description:
          `Run a command on the user's PC and return its output. Anything starting with one of these is allowed: ${ALLOWED_PREFIXES.join(", ")}. Start a project however it is built - "npm start" or "npm run dev" for node, "python app.py" for python - and pass open_browser true in the same call to have the page opened once it is up. A server does not finish: the reply comes back with started true and the work carries on, so say it is running rather than waiting for it. Always pass cwd for anything belonging to a project, or the command runs in the workspace root and finds no package.json. Do not use this for coding or file edits - that is what run_claude is for. Nothing else is permitted, commands may not be chained, and every path must be relative to the workspace.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command line to run, e.g. 'git status' or 'npm run dev'.",
            },
            cwd: {
              // Must accept null: the model sends cwd=null when omitting it,
              // and Groq validates tool arguments server-side and 400s on a
              // bare "string".
              type: ["string", "null"],
              description:
                "Optional project folder to run in, e.g. 'landing page'. Pass this whenever the command belongs to a project - 'npm start' in the workspace root will not find the project's package.json. Omit or pass null for a command about the machine itself.",
            },
            open_browser: {
              type: ["boolean", "null"],
              description:
                "Pass true when starting a dev server the user wants to see. The page is opened at whatever address the server reported, so you do not need to know the port or call 'start' yourself. Ignored for commands that are not servers.",
            },
            port: {
              type: ["integer", "null"],
              description:
                "Only useful with open_browser, and only as a fallback: if the server prints its address, that is used instead. Pass the port you expect from package.json - 5173 for vite, 3000 for create-react-app or next.",
            },
          },
          required: ["command"],
        },
      },
    },
    handler: async ({ command, cwd, open_browser: openBrowser, port }, { timeoutMs, sessionKey }) => {
      if (!command) {
        return { ok: false, error: "No command given." };
      }

      const folder = typeof cwd === "string" ? cwd.trim() : "";

      if (hasShellMetacharacters(command)) {
        logError(`[TOOL] BLOCKED, shell metacharacters: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" has shell characters I won't run. Ask for one plain command.`,
        };
      }

      // The rule that survived autonomy. Nothing asks the user any more, so
      // this is what decides where a command can reach.
      if (escapesWorkspace(command)) {
        logError(`[TOOL] BLOCKED, leaves the workspace: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" points outside the project workspace. I can only work on files in there, named with relative paths.`,
        };
      }

      // The allowlist is now the whole decision - there is no second chance
      // for a command to be permitted by being confirmed.
      if (!isAllowed(command)) {
        logError(`[TOOL] BLOCKED by allowlist: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" is not on the allowed list. ${
            argumentRefusal(command) ?? `Permitted: ${ALLOWED_PREFIXES.join(", ")}.`
          }`,
        };
      }

      const args = { command, ...(folder ? { cwd: folder } : {}) };
      const label = folder ? `${command} (in ${folder})` : command;

      // Three shapes of command, and getting this wrong is what made starting a
      // dev server look broken. A server is spawned and confirmed, never polled
      // to an exit that is not coming. Slow-but-finite work is polled, because
      // there is an end to poll for. Everything else answers inline.
      if (isDaemon(command)) {
        const started = await execute("start_daemon", args, { timeoutMs });

        if (started?.ok === false) {
          return started;
        }

        // It exited inside the confirmation window, so it was a script rather
        // than a server. Fall through to the ordinary reporting below.
        if (started?.started !== true) {
          return {
            ok: true,
            command,
            ...(folder ? { cwd: folder } : {}),
            output: String(started?.output ?? "").slice(0, 800),
          };
        }

        const opened = await openIfAsked({ openBrowser, port, url: started?.url, timeoutMs });

        // Tracked so stop_server has something to stop. Without this the
        // process is running with nothing on this side knowing it exists.
        if (started?.job_id) {
          registerDaemon({
            sessionKey,
            remoteId: started.job_id,
            command,
            cwd: folder || null,
            url: opened.url ?? started?.url ?? null,
          });
        }

        return {
          ok: true,
          status: "running",
          started: true,
          message: "Dev server is running in background",
          command,
          ...(started?.job_id ? { job_id: started.job_id } : {}),
          ...(folder ? { cwd: folder } : {}),
          ...opened,
        };
      }

      const result = isLongRunning(command)
        ? await runRemoteJob("start_command", args, label)
        : await execute("run_command", args, { timeoutMs });

      if (result?.ok === false) {
        return result;
      }

      // Keep tool output small - it is fed back into the next prompt and then
      // spoken aloud.
      const output =
        typeof result?.output === "string"
          ? result.output.slice(0, 800)
          : JSON.stringify(result).slice(0, 800);

      return { ok: true, command, ...(folder ? { cwd: folder } : {}), output };
    },
  },

  run_claude: {
    backgroundable: true,
    describe: (args) =>
      `ask Claude to ${args.prompt ?? "do something"}${args.cwd ? ` in ${args.cwd}` : ""}`,
    // The appended instruction is stripped, because it is boilerplate the user
    // never asked for and would otherwise be narrated back at them every time
    // the reprompt fires.
    narrate: ({ prompt, cwd }) =>
      `Claude is currently building ${withoutAutonomy(String(prompt ?? "that"))}${
        cwd ? ` in ${cwd}` : ""
      }`,
    schema: {
      type: "function",
      function: {
        name: "run_claude",
        description:
          "Hand a coding or file-editing task to the Claude CLI on the user's PC. Use this for anything that writes, edits, refactors, explains or reviews code - it is the only tool that can change files. Pass the user's request as the prompt, in full and in plain English, and append the instruction the system prompt gives you for this tool. It runs straight away without asking, and takes minutes, so say what you are starting and let it finish in the background.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "The instruction for Claude, e.g. 'build a landing page with a signup form'. Write it out in full - Claude cannot see this conversation.",
            },
            cwd: {
              // Must accept null: the model sends cwd=null when omitting it,
              // and Groq validates tool arguments server-side and 400s on a
              // bare "string".
              type: ["string", "null"],
              description:
                "Optional project folder to work in, e.g. 'landing page'. Always pass this when the user is working on a project, or the files land in the workspace root instead of the project. The folder must already exist - check_directory first. Omit or pass null only when no project has been named.",
            },
          },
          required: ["prompt"],
        },
      },
    },
    // The prompt is passed as an argument, never as part of a command line,
    // so it needs no allowlist and no metacharacter check: $ and () in a
    // prompt are just text. Confirmation is what authorises it.
    // No timeoutMs: this always goes down the job path, which sets its own.
    handler: async ({ prompt, cwd }) => {
      const instruction = typeof prompt === "string" ? prompt.trim() : "";
      const folder = typeof cwd === "string" ? cwd.trim() : "";

      if (!instruction) {
        return { ok: false, error: "No prompt given." };
      }

      const result = await runRemoteJob(
        "start_claude",
        {
          prompt: withAutonomy(instruction),
          ...(folder ? { cwd: folder } : {}),
        },
        folder ? `${instruction} (in ${folder})` : instruction,
      );

      if (result?.ok === false) {
        return result;
      }

      const output =
        typeof result?.output === "string"
          ? result.output.slice(-800)
          : JSON.stringify(result).slice(0, 800);

      return { ok: true, prompt: instruction, ...(folder ? { cwd: folder } : {}), output };
    },
  },

  check_directory: {
    // Never a job: the whole point is that the assistant can ask "which
    // project?" and act on the answer inside one spoken turn.
    backgroundable: false,
    describe: (args) => `check for ${args.project ?? "a project"}`,
    schema: {
      type: "function",
      function: {
        name: "check_directory",
        description:
          "Check whether a project folder already exists in the user's workspace. Always call this before opening or creating a project. It is instant, read-only and needs no confirmation. It also returns the projects that do exist, so you can offer them if the name was misheard.",
        parameters: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description:
                "The project name as the user said it, e.g. 'landing page'. Spaces are fine - it is matched against the folder names on disk.",
            },
          },
          required: ["project"],
        },
      },
    },
    handler: async ({ project }, { timeoutMs }) => {
      if (!project) {
        return { ok: false, error: "No project name given." };
      }

      return execute("check_directory", { project }, { timeoutMs });
    },
  },

  open_project: {
    backgroundable: true,
    describe: (args) => `open ${args.project ?? "a project"} in VS Code`,
    schema: {
      type: "function",
      function: {
        name: "open_project",
        description:
          "Open an existing project from the user's workspace in VS Code. Only call this after check_directory has confirmed the folder exists. This is the only way to open VS Code - there is no tool that opens the workspace root, so if the user has not named a project yet, ask them which one.",
        parameters: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "The project name, as passed to check_directory.",
            },
          },
          required: ["project"],
        },
      },
    },
    handler: async ({ project }, { timeoutMs }) => {
      if (!project) {
        return { ok: false, error: "No project name given." };
      }

      return execute("open_project", { project }, { timeoutMs });
    },
  },

  init_project: {
    backgroundable: true,
    describe: (args) => `start ${args.project ?? "a project"}`,
    narrate: ({ project }) => `setting up ${project ?? "a new project"}`,
    schema: {
      type: "function",
      function: {
        name: "init_project",
        description:
          "Create a new project folder in the user's workspace, run git init inside it and open it in VS Code. Call this when check_directory reports the project does not exist. Do not ask whether to create it - say that you are setting it up and call this.",
        parameters: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "The project name, as passed to check_directory.",
            },
          },
          required: ["project"],
        },
      },
    },
    handler: async ({ project }, { timeoutMs }) => {
      if (!project) {
        return { ok: false, error: "No project name given." };
      }

      return execute("init_project", { project }, { timeoutMs });
    },
  },

  check_running_servers: {
    // Never a job, for the same reason as check_job_status: asking what is
    // running must not itself become something to wait for.
    backgroundable: false,
    describe: () => "check running servers",
    schema: {
      type: "function",
      function: {
        name: "check_running_servers",
        description:
          "List the dev servers currently running on the user's PC, with their addresses and how long they have been up. Call this whenever the user asks what is running, what servers or environments are active, whether a project is still up, or for the state of their dev environment. It is instant and read-only.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async (_args, { timeoutMs, sessionKey }) => {
      const result = await execute("list_daemons", {}, { timeoutMs });
      const live = Array.isArray(result?.servers) ? result.servers : [];
      const tracked = getAllDaemons();
      const mine = getSessionDaemons(sessionKey);
      const liveIds = new Set(live.map((server) => server.job_id));

      // The executor is the only thing that knows whether a process is still
      // alive - this side only finds out when it asks. A server that crashed on
      // its own would otherwise stay tracked forever, and stop_server would
      // keep aiming at an id that is gone.
      for (const daemon of tracked) {
        if (!liveIds.has(daemon.remoteId)) {
          logWarn(`[TOOL] ${daemon.remoteId} is gone - releasing "${daemon.command}"`);
          forgetDaemon(daemon.remoteId);
        }
      }

      const byId = new Map(mine.map((daemon) => [daemon.remoteId, daemon]));

      return {
        ok: true,
        count: live.length,
        servers: live.map((server) => ({
          ...server,
          // The address only this side knows, from when the server printed it.
          ...(byId.get(server.job_id)?.url ? { url: byId.get(server.job_id).url } : {}),
          // Whether this conversation is the one that started it, so the model
          // can say "the server I started" rather than guessing.
          started_here: byId.has(server.job_id),
        })),
        ...(live.length ? {} : { note: "Nothing is running." }),
      };
    },
  },

  stop_server: {
    // Never a job: stopping is the thing the user is waiting to hear about, and
    // taskkill returns in moments.
    backgroundable: false,
    describe: (args) => `stop ${args.job_id ? `server ${args.job_id}` : "the running server"}`,
    schema: {
      type: "function",
      function: {
        name: "stop_server",
        description:
          "Stop a dev server started earlier. Call this when the user asks to stop the server, shut the project down, or kill the dev environment. Takes no arguments in the normal case - it stops the server running in this conversation, or the ones still up from an earlier one if this conversation started none.",
        parameters: {
          type: "object",
          properties: {
            job_id: {
              // Must accept null: the model sends job_id=null when omitting it,
              // and Groq validates tool arguments server-side and 400s on a
              // bare "string".
              type: ["string", "null"],
              description:
                "Only when stopping one specific server out of several, using an id from a previous result. Omit or pass null to stop the server in this conversation.",
            },
          },
        },
      },
    },
    handler: async ({ job_id: jobId }, { timeoutMs, sessionKey }) => {
      const mine = getSessionDaemons(sessionKey);

      if (jobId) {
        // Confined to this conversation's own servers. Two sessions on one
        // machine should not be able to reach into each other by guessing ids.
        if (!mine.some((daemon) => daemon.remoteId === jobId)) {
          return {
            ok: false,
            error: `No server ${jobId} was started in this conversation.`,
          };
        }

        const result = await execute("stop_daemon", { job_id: jobId }, { timeoutMs });

        if (result?.ok !== false) {
          forgetDaemon(jobId);
        }

        return { ok: result?.ok !== false, stopped: 1, ...(result?.ok === false ? result : {}) };
      }

      // Nothing tracked here. An Alexa session is short and a dev server
      // outlives it, so by the time someone says "stop the server" the
      // conversation that started it is usually gone - falling back to whatever
      // is still up is the only reading of that request that helps them.
      if (!mine.length) {
        const result = await execute("stop_daemon", { all: true }, { timeoutMs });
        const stopped = result?.stopped?.length ?? 0;

        if (!stopped && !(result?.already_stopped?.length ?? 0)) {
          return { ok: true, stopped: 0, note: "No server was running." };
        }

        return { ok: result?.ok !== false, stopped, note: "Stopped what was still running." };
      }

      const results = [];

      for (const daemon of mine) {
        const result = await execute("stop_daemon", { job_id: daemon.remoteId }, { timeoutMs });

        if (result?.ok !== false) {
          forgetDaemon(daemon.remoteId);
        }

        results.push({ command: daemon.command, ok: result?.ok !== false });
      }

      const failed = results.filter((entry) => !entry.ok);

      return {
        ok: !failed.length,
        stopped: results.length - failed.length,
        servers: results.map((entry) => entry.command),
        ...(failed.length ? { error: `Could not stop ${failed.map((e) => e.command).join(", ")}.` } : {}),
      };
    },
  },

  check_background_jobs: {
    backgroundable: false,
    describe: () => "check background jobs",
    schema: {
      type: "function",
      function: {
        name: "check_background_jobs",
        description:
          "Check background tasks - a Claude build, an install, a project being scaffolded. Call this whenever the user asks whether something finished, says 'is it done', asks for a status update, or asks about work you told them you had started, even if that was in an earlier conversation. It reads every job, not only this conversation's, so it still answers after the skill has been closed and re-opened. Report the result it gives you: what finished and what it produced, or that it is still going and roughly how long it has been.",
        parameters: {
          type: "object",
          properties: {
            job_id: {
              // Must accept null: the model sends job_id=null when omitting it, and
              // Groq validates tool arguments server-side and 400s on a bare "string".
              type: ["string", "null"],
              description: "Optional specific job id. Omit or pass null to list every job.",
            },
          },
        },
      },
    },
    // No sessionKey: a job is looked up across every session on purpose. The
    // conversation that started it has usually ended by the time anyone asks,
    // and answering "no tasks in this conversation" while one is running would
    // be the wrong answer to the only question the user came back with.
    handler: async ({ job_id: jobId }) => {
      const all = getAllJobs();

      if (!all.length) {
        return { ok: true, jobs: [], note: "Nothing has been started in the background." };
      }

      const matched = jobId ? all.filter((job) => job.id === jobId) : all;

      if (!matched.length) {
        return { ok: false, error: `No job "${jobId}".` };
      }

      // Only a finished job counts as reported - marking a running one would
      // suppress the "it is done now" note when it actually completes.
      for (const job of matched) {
        if (job.status !== "running") {
          job.reported = true;
        }
      }

      const running = matched.filter((job) => job.status === "running").length;

      return {
        ok: true,
        jobs: matched.map(describeJob),
        ...(running ? { still_running: running } : {}),
      };
    },
  },
};

export const toolSchemas = Object.values(TOOLS).map((tool) => tool.schema);

export const isBackgroundable = (toolName) => TOOLS[toolName]?.backgroundable === true;

export const describeToolCall = (toolName, args) => {
  try {
    return TOOLS[toolName]?.describe?.(args) ?? toolName;
  } catch {
    return toolName;
  }
};

export const parseToolArgs = (toolCall) => {
  try {
    return JSON.parse(toolCall?.function?.arguments || "{}");
  } catch {
    return null;
  }
};

// Always resolves. A failure comes back as { ok: false, error } so it can be
// appended to history and explained by the model, instead of 500ing the turn.
export const runTool = async (toolCall, context = {}) => {
  const name = toolCall?.function?.name;
  const tool = TOOLS[name];
  const elapsed = startTimer();

  if (!tool) {
    logError(`[TOOL] unknown tool requested: ${name}`);
    return { ok: false, error: `Unknown tool "${name}".` };
  }

  const args = parseToolArgs(toolCall);

  if (args === null) {
    logError(`[TOOL] ${name} unparseable arguments: ${preview(toolCall?.function?.arguments, 200)}`);
    return { ok: false, error: `Could not parse arguments for "${name}".` };
  }

  log(`[TOOL] ${name} start args=${preview(args, 200)} timeout=${context.timeoutMs ?? INLINE_TIMEOUT_MS}ms`);

  try {
    const result = await tool.handler(args, {
      timeoutMs: INLINE_TIMEOUT_MS,
      ...context,
    });

    log(`[TOOL] ${name} done in ${elapsed()}ms -> ${preview(result, 250)}`);
    return result;
  } catch (error) {
    logError(`[TOOL] ${name} failed in ${elapsed()}ms: ${error.message}`);
    return { ok: false, error: error.message };
  }
};
