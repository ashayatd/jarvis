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

// Deliberately narrow. This endpoint is reachable from the public internet,
// so anything added here is runnable by anyone who finds the tunnel URL.
// Read-only commands only until the executor requires EXECUTOR_SECRET.
const ALLOWED_COMMANDS = [
  "git status",
  "git log",
  "git branch",
  "git diff",
  "git remote",
  "dir",
  "ls",
  // Reads a file. Relative paths resolve inside the workspace because that is
  // the executor's cwd - but an absolute one does not, so this can read any
  // file the executor's user can. See the note above about what reaching this
  // endpoint means.
  "type",
  "whoami",
  "date",
  "node -v",
  "npm -v",
];

// Commands that change something: the repo, the installed packages, or files
// on disk by way of the Claude CLI. These are never run on the model's word
// alone - the user has to say yes out loud first. Prefix match, so "git "
// gates every git subcommand, the read-only ones included.
export const MUTATING_PREFIXES = ["git ", "npm ", "npx ", "claude "];

// Chaining defeats prefix matching on its own: "git status && rm -rf ."
// starts with an allowed prefix. Reject anything that could begin a second
// command before either the allowlist or the confirmation gate runs.
const SHELL_METACHARACTERS = /[;&|<>`$()\x00-\x1f]/;

const hasShellMetacharacters = (command) => SHELL_METACHARACTERS.test(command);

// The trailing space makes a bare "git" match the "git " prefix, so the gate
// cannot be stepped around by leaving the arguments off.
const isMutating = (command) => {
  const normalized = `${String(command ?? "").trim().toLowerCase()} `;

  return MUTATING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const isAllowed = (command) => {
  const normalized = command.trim().toLowerCase();

  return ALLOWED_COMMANDS.some(
    (allowed) => normalized === allowed || normalized.startsWith(`${allowed} `),
  );
};

// What has to be confirmed before this tool call may run, or null if it can
// go straight through. The policy lives on each tool as `confirm`, so a tool
// and the rule that gates it cannot drift apart. A tool with no `confirm`
// never gates.
//
// `prompt` is what the user hears. A tool that leaves it out gets the default
// "That will run X" wording; one that sets it asks its own question, which is
// how the VS Code flow gets to ask about initialising a repo instead.
export const confirmationFor = (toolCall) => {
  const tool = TOOLS[toolCall?.function?.name];
  const args = parseToolArgs(toolCall);

  if (!tool?.confirm || args === null) {
    return null;
  }

  try {
    const held = tool.confirm(args);

    return held ? { ...held, toolCall } : null;
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
    // Read-only commands skip the gate even when they match a mutating
    // prefix: "git status" is on the allowlist for a reason, and making the
    // user confirm it turns every status check into two turns for nothing.
    // The handler below checks these in the same order - if they disagreed,
    // the gate would hold a command the handler was going to run anyway.
    confirm: ({ command }) => {
      const wanted = typeof command === "string" ? command.trim() : "";

      if (!wanted || hasShellMetacharacters(wanted)) {
        return null;
      }

      if (isAllowed(wanted) || !isMutating(wanted)) {
        return null;
      }

      return { command: wanted };
    },
    schema: {
      type: "function",
      function: {
        name: "run_command",
        description:
          `Run a command on the user's PC and return its output. These run straight away: ${ALLOWED_COMMANDS.join(", ")}. Commands starting with ${MUTATING_PREFIXES.map((prefix) => prefix.trim()).join(", ")} are allowed too, but the user is asked to confirm them out loud first - call the tool as normal and the confirmation is handled for you. Do not use this for coding or file edits - that is what run_claude is for. Nothing else is permitted, and commands may not be chained.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command line to run, e.g. 'git status'.",
            },
          },
          required: ["command"],
        },
      },
    },
    // `confirmed` is set only by the route handler, and only once the user has
    // said yes to this exact command. It is the only way a mutating command
    // reaches the executor.
    handler: async ({ command }, { timeoutMs, confirmed = false }) => {
      if (!command) {
        return { ok: false, error: "No command given." };
      }

      if (hasShellMetacharacters(command)) {
        logError(`[TOOL] BLOCKED, shell metacharacters: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" has shell characters I won't run. Ask for one plain command.`,
        };
      }

      // Allowlist first, so a read-only command runs instantly even though it
      // matches a mutating prefix. Same order as confirmationFor.
      const readOnly = isAllowed(command);

      if (!readOnly && !(isMutating(command) && confirmed)) {
        logError(`[TOOL] BLOCKED by allowlist: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" is not on the allowed list. Permitted: ${ALLOWED_COMMANDS.join(", ")}.`,
        };
      }

      const result = readOnly
        ? await execute("run_command", { command }, { timeoutMs })
        : await runRemoteJob("start_command", { command }, command);

      if (result?.ok === false) {
        return result;
      }

      // Keep tool output small - it is fed back into the next prompt and then
      // spoken aloud.
      const output =
        typeof result?.output === "string"
          ? result.output.slice(0, 800)
          : JSON.stringify(result).slice(0, 800);

      return { ok: true, command, output };
    },
  },

  run_claude: {
    backgroundable: true,
    describe: (args) =>
      `ask Claude to ${args.prompt ?? "do something"}${args.cwd ? ` in ${args.cwd}` : ""}`,
    // Every Claude run edits files, so the prompt is always read back first -
    // minus the appended instruction, which the user did not ask for and does
    // not need to hear.
    confirm: ({ prompt, cwd }) => {
      const wanted = typeof prompt === "string" ? withoutAutonomy(prompt) : "";

      if (!wanted) {
        return null;
      }

      // Where the files will land is part of what is being agreed to, so it
      // is read back as well.
      const where = typeof cwd === "string" && cwd.trim() ? `, in ${cwd.trim()}` : "";

      return { command: `Claude with: ${wanted}${where}` };
    },
    schema: {
      type: "function",
      function: {
        name: "run_claude",
        description:
          "Hand a coding or file-editing task to the Claude CLI on the user's PC. Use this for anything that writes, edits, refactors, explains or reviews code - it is the only tool that can change files. Pass the user's request as the prompt, in full and in plain English, and append the instruction the system prompt gives you for this tool. The user is asked to confirm out loud before it runs, and the work takes minutes, so it usually finishes in the background.",
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
    handler: async ({ prompt, cwd }, { confirmed = false }) => {
      const instruction = typeof prompt === "string" ? prompt.trim() : "";
      const folder = typeof cwd === "string" ? cwd.trim() : "";

      if (!instruction) {
        return { ok: false, error: "No prompt given." };
      }

      if (!confirmed) {
        logError(`[TOOL] BLOCKED, unconfirmed Claude run: ${preview(instruction, 120)}`);

        return { ok: false, error: "The user has not confirmed this yet." };
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
    // Creates a directory and a repo, so it is gated - but with its own
    // question, because "that project isn't present, should I initialise a
    // new repo?" is the confirmation here. Asking in prose as well would make
    // the user say yes twice.
    confirm: ({ project }) => {
      const wanted = typeof project === "string" ? project.trim() : "";

      return wanted
        ? {
            command: `git init in ${wanted}`,
            prompt: "That project isn't present. Should I initialize a new repo?",
          }
        : null;
    },
    schema: {
      type: "function",
      function: {
        name: "init_project",
        description:
          "Create a new project folder in the user's workspace, run git init inside it and open it in VS Code. Call this when check_directory reports the project does not exist. Do not ask in prose whether to create it first - the user is asked to confirm automatically, so asking yourself would make them confirm twice.",
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
    handler: async ({ project }, { timeoutMs, confirmed = false }) => {
      if (!project) {
        return { ok: false, error: "No project name given." };
      }

      if (!confirmed) {
        logError(`[TOOL] BLOCKED, unconfirmed init: ${preview(project, 120)}`);

        return { ok: false, error: "The user has not confirmed this yet." };
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
