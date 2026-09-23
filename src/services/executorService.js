import { log, logError, preview, startTimer } from "../utils/logger.js";

// EXECUTOR_URL is the current name; VSCODE_AUTOMATION_URL is still read so an
// older .env keeps working.
const EXECUTOR_URL =
  process.env.EXECUTOR_URL ||
  process.env.VSCODE_AUTOMATION_URL ||
  "http://127.0.0.1:5000/execute";

// Inline work has to fit Alexa's ~8s budget; a backgrounded job does not, so
// the ceiling is per call rather than global.
export const INLINE_TIMEOUT_MS = Number(process.env.EXECUTOR_TIMEOUT_MS || 4000);
export const BACKGROUND_TIMEOUT_MS = Number(process.env.EXECUTOR_BG_TIMEOUT_MS || 120000);

// How long a confirmed command may take on the PC before it is given up on.
// A Claude CLI run is minutes, not seconds, so this is far longer than either
// of the above - it bounds a poll loop, not a single open request.
export const REMOTE_JOB_TIMEOUT_MS = Number(process.env.EXECUTOR_JOB_TIMEOUT_MS || 900000);

// The automation URL is public. Set EXECUTOR_SECRET on both ends and have the
// PC agent reject requests that arrive without it.
const EXECUTOR_SECRET = process.env.EXECUTOR_SECRET;

export const execute = async (command, args = {}, { timeoutMs = INLINE_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const elapsed = startTimer();

  log(
    `[EXEC] -> ${EXECUTOR_URL}`,
    `command=${command}`,
    Object.keys(args).length ? `args=${preview(args, 200)}` : "",
    `timeout=${timeoutMs}ms`,
  );

  try {
    const response = await fetch(EXECUTOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EXECUTOR_SECRET ? { "X-Executor-Secret": EXECUTOR_SECRET } : {}),
      },
      body: JSON.stringify({
        command,
        ...(Object.keys(args).length ? { args } : {}),
      }),
      signal: controller.signal,
    });

    const body = await response.text();

    if (!response.ok) {
      logError(`[EXEC] <- ${response.status} after ${elapsed()}ms: ${preview(body, 200)}`);
      throw new Error(`executor returned ${response.status}: ${body.slice(0, 200)}`);
    }

    log(`[EXEC] <- ${response.status} after ${elapsed()}ms: ${preview(body, 200)}`);

    try {
      return JSON.parse(body);
    } catch {
      return { ok: true, output: body.slice(0, 500) };
    }
  } catch (error) {
    if (error.name === "AbortError") {
      logError(`[EXEC] aborted: no response within ${timeoutMs}ms (command=${command})`);
      throw new Error(`executor timed out after ${timeoutMs}ms`);
    }

    if (error.cause?.code === "ENOTFOUND" || error.cause?.code === "ECONNREFUSED") {
      logError(`[EXEC] unreachable (${error.cause.code}) after ${elapsed()}ms - PC agent / tunnel down?`);
      throw new Error("executor unreachable - is the PC agent and tunnel running?");
    }

    logError(`[EXEC] failed after ${elapsed()}ms: ${error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
