import { log } from "../utils/logger.js";

const EXECUTOR_URL =
  process.env.VSCODE_AUTOMATION_URL ||
  "https://saturnina-preoceanic-domenica.ngrok-free.dev/execute";

// Alexa gives us ~8s total. Two tool rounds plus two LLM calls have to fit,
// so the machine hop gets a hard ceiling.
const EXECUTOR_TIMEOUT_MS = Number(process.env.EXECUTOR_TIMEOUT_MS || 4000);

// The automation URL is public. Set EXECUTOR_SECRET on both ends and have the
// PC agent reject requests without it.
const EXECUTOR_SECRET = process.env.EXECUTOR_SECRET;

export const execute = async (command, args = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);

  log(`executor -> ${command}`, Object.keys(args).length ? JSON.stringify(args) : "");

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
      throw new Error(`executor returned ${response.status}: ${body.slice(0, 200)}`);
    }

    try {
      return JSON.parse(body);
    } catch {
      return { ok: true, output: body.slice(0, 500) };
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`executor timed out after ${EXECUTOR_TIMEOUT_MS}ms`);
    }

    if (error.cause?.code === "ENOTFOUND" || error.cause?.code === "ECONNREFUSED") {
      throw new Error("executor unreachable - is the PC agent and tunnel running?");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
};
