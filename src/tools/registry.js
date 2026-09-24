import { AUTONOMOUS_SUFFIX } from "../data/chatMemory.js";
import { describeJob, getSessionJobs } from "../data/jobRegistry.js";
import {
  execute,
  INLINE_TIMEOUT_MS,
  REMOTE_JOB_TIMEOUT_MS,
} from "../services/executorService.js";
import { log, logError, preview, startTimer } from "../utils/logger.js";

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
// "start" and "npx" are the widest entries by a distance. "start" launches
// whatever is registered for what follows it, and "npx" fetches and runs code
// from the registry - once that is a subprocess, no rule here constrains what
// it does. Narrowing either is a one-line change in this list.
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

// Commands that finish in a moment and can be answered inline. Everything else
// allowed is treated as long-running and sent down the job path instead,
// because inline means the executor's 15 second ceiling - which would kill a
// dev server just as it finished booting and report it as a timeout.
//
// Stated as the short list rather than the long one so a new entry above is
// slow by default: waiting a little too long for an answer is a much smaller
// problem than a killed server reported as a failure.
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

// Both exported for the same reason as escapesWorkspace: a prefix list is a
// set of promises about what may follow each entry, and that is worth asserting
// directly rather than only through whatever a tool does with the answer.
export const isAllowed = (command) => matchesPrefix(command, ALLOWED_PREFIXES);

export const isLongRunning = (command) => !matchesPrefix(command, INSTANT_PREFIXES);

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
          `Run a command on the user's PC and return its output. Anything starting with one of these runs straight away: ${ALLOWED_PREFIXES.join(", ")}, and "start <url>" to open a page in the browser. Use them to start a project however it is built - "npm start" or "npm run dev" for node, "python app.py" for python - and "start http://localhost:3000" to open it in the browser. Pass cwd so it runs in the project rather than the workspace root. A server keeps running in the background, so say it has started rather than waiting for it to finish. Commands starting with ${MUTATING_PREFIXES.map((prefix) => prefix.trim()).join(", ")} are allowed too, but the user is asked to confirm those out loud first - call the tool as normal and the confirmation is handled for you. Do not use this for coding or file edits - that is what run_claude is for. Nothing else is permitted, commands may not be chained, and every path must be relative to the workspace.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command line to run, e.g. 'git status' or 'npm start'.",
            },
            cwd: {
              // Must accept null: the model sends cwd=null when omitting it,
              // and Groq validates tool arguments server-side and 400s on a
              // bare "string".
              type: ["string", "null"],
              description:
                "Optional project folder to run in, e.g. 'landing page'. Pass this whenever the command belongs to a project - 'npm start' in the workspace root will not find the project's package.json. Omit or pass null for a command about the machine itself.",
            },
          },
          required: ["command"],
        },
      },
    },
    handler: async ({ command, cwd }, { timeoutMs }) => {
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
          error: `"${command}" is not on the allowed list. Permitted: ${ALLOWED_PREFIXES.join(", ")}.`,
        };
      }

      const args = { command, ...(folder ? { cwd: folder } : {}) };
      const label = folder ? `${command} (in ${folder})` : command;

      // Inline only when it will actually finish. A dev server would hit the
      // executor's 15 second ceiling and be killed, so anything not on the
      // instant list goes down the job path - the spoken reply then says it
      // started rather than waiting for an end that is not coming.
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

  check_job_status: {
    backgroundable: false,
    describe: () => "check background jobs",
    schema: {
      type: "function",
      function: {
        name: "check_job_status",
        description:
          "Check background tasks started earlier in this conversation. Call this whenever the user asks whether something finished, wants a status update, or asks about a task you told them you had started.",
        parameters: {
          type: "object",
          properties: {
            job_id: {
              // Must accept null: the model sends job_id=null when omitting it, and
              // Groq validates tool arguments server-side and 400s on a bare "string".
              type: ["string", "null"],
              description: "Optional specific job id. Omit or pass null to list every job in this conversation.",
            },
          },
        },
      },
    },
    handler: async ({ job_id }, { sessionKey }) => {
      const all = getSessionJobs(sessionKey);

      if (!all.length) {
        return { ok: true, jobs: [], note: "No background tasks have been started in this conversation." };
      }

      const matched = job_id ? all.filter((job) => job.id === job_id) : all;

      if (!matched.length) {
        return { ok: false, error: `No job "${job_id}" in this conversation.` };
      }

      // Only a finished job counts as reported - marking a running one would
      // suppress the "it is done now" note when it actually completes.
      for (const job of matched) {
        if (job.status !== "running") {
          job.reported = true;
        }
      }

      return { ok: true, jobs: matched.map(describeJob) };
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
