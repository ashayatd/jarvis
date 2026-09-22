import { execute } from "../services/executorService.js";
import { logError } from "../utils/logger.js";

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
const TOOLS = {
  open_app: {
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
    handler: async ({ app }) => {
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

      await execute(command);
      return { ok: true, opened: app };
    },
  },

  run_command: {
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
    handler: async ({ command }) => {
      if (!command) {
        return { ok: false, error: "No command given." };
      }

      if (!isAllowed(command)) {
        return {
          ok: false,
          error: `"${command}" is not on the allowed list. Permitted: ${ALLOWED_COMMANDS.join(", ")}.`,
        };
      }

      const result = await execute("run_command", { command });

      // Keep tool output small - it is fed back into the next prompt and then
      // spoken aloud.
      const output =
        typeof result?.output === "string"
          ? result.output.slice(0, 800)
          : JSON.stringify(result).slice(0, 800);

      return { ok: true, command, output };
    },
  },
};

export const toolSchemas = Object.values(TOOLS).map((tool) => tool.schema);

// Always resolves. A failure comes back as { ok: false, error } so it can be
// appended to history and explained by the model, instead of 500ing the turn.
export const runTool = async (toolCall) => {
  const name = toolCall?.function?.name;
  const tool = TOOLS[name];

  if (!tool) {
    return { ok: false, error: `Unknown tool "${name}".` };
  }

  let args = {};

  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    return { ok: false, error: `Could not parse arguments for "${name}".` };
  }

  try {
    return await tool.handler(args);
  } catch (error) {
    logError(`tool "${name}" failed:`, error.message);
    return { ok: false, error: error.message };
  }
};
