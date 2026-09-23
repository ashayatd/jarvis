import { describeJob, getSessionJobs } from "../data/jobRegistry.js";
import {
  execute,
  INLINE_TIMEOUT_MS,
  REMOTE_JOB_TIMEOUT_MS,
} from "../services/executorService.js";
import { log, logError, preview, startTimer } from "../utils/logger.js";

// Spoken app names -> the command your PC agent actually receives.
// Only `open_vscode` is confirmed to exist on the agent today; the rest need
// matching handlers added there before they will work.
const APP_COMMANDS = {
  "vscode": "open_vscode",
  "vs code": "open_vscode",
  "visual studio code": "open_vscode",
  "code": "open_vscode",
  "editor": "open_vscode",
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
// go straight through. A command carrying metacharacters is left to the
// handler to refuse outright - it is not something to offer the user.
export const confirmationFor = (toolCall) => {
  if (toolCall?.function?.name !== "run_command") {
    return null;
  }

  const args = parseToolArgs(toolCall);
  const command = typeof args?.command === "string" ? args.command.trim() : "";

  if (!command || hasShellMetacharacters(command) || !isMutating(command)) {
    return null;
  }

  return { command, toolCall };
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
const runRemoteJob = async (command) => {
  const started = await execute("start_command", { command }, { timeoutMs: INLINE_TIMEOUT_MS });
  const remoteId = started?.job_id;

  if (!remoteId) {
    return { ok: false, error: `Executor did not start "${command}".` };
  }

  log(`[TOOL] remote job ${remoteId} started for "${preview(command, 80)}"`);

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
    error: `"${command}" is still running after ${Math.round(REMOTE_JOB_TIMEOUT_MS / 60000)} minutes.`,
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
    schema: {
      type: "function",
      function: {
        name: "run_command",
        description:
          `Run a command on the user's PC and return its output. These run straight away: ${ALLOWED_COMMANDS.join(", ")}. Commands starting with ${MUTATING_PREFIXES.map((prefix) => prefix.trim()).join(", ")} are allowed too, but the user is asked to confirm them out loud first - call the tool as normal and the confirmation is handled for you. Hand coding and file edits to the Claude CLI as claude -p "<instruction>". Nothing else is permitted, and commands may not be chained.`,
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

      const mutating = isMutating(command);

      if (mutating ? !confirmed : !isAllowed(command)) {
        logError(`[TOOL] BLOCKED by allowlist: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" is not on the allowed list. Permitted: ${ALLOWED_COMMANDS.join(", ")}.`,
        };
      }

      const result = mutating
        ? await runRemoteJob(command)
        : await execute("run_command", { command }, { timeoutMs });

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
