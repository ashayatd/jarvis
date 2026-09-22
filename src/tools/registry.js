import { describeJob, getSessionJobs } from "../data/jobRegistry.js";
import { execute, INLINE_TIMEOUT_MS } from "../services/executorService.js";
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

// Chaining defeats prefix matching on its own: "git status && rm -rf ."
// starts with an allowed prefix. Reject anything that could begin a second
// command before the prefix check runs.
const SHELL_METACHARACTERS = /[;&|<>`$()\x00-\x1f]/;

const isAllowed = (command) => {
  const normalized = command.trim().toLowerCase();

  if (SHELL_METACHARACTERS.test(normalized)) {
    return false;
  }

  return ALLOWED_COMMANDS.some(
    (allowed) => normalized === allowed || normalized.startsWith(`${allowed} `),
  );
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
          `Run a read-only command on the user's PC and return its output. Only these commands are permitted: ${ALLOWED_COMMANDS.join(", ")}. Do not attempt anything else.`,
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
    handler: async ({ command }, { timeoutMs }) => {
      if (!command) {
        return { ok: false, error: "No command given." };
      }

      if (!isAllowed(command)) {
        logError(`[TOOL] BLOCKED by allowlist: ${preview(command, 120)}`);

        return {
          ok: false,
          error: `"${command}" is not on the allowed list. Permitted: ${ALLOWED_COMMANDS.join(", ")}.`,
        };
      }

      const result = await execute("run_command", { command }, { timeoutMs });

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
