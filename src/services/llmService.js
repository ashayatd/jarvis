import { buildMessages } from "../data/chatMemory.js";
import { log, logError, logWarn, preview, startTimer } from "../utils/logger.js";
import { createGroqProvider } from "./providers/groqProvider.js";
import { createOllamaProvider } from "./providers/ollamaProvider.js";

// The one interface the agent loop talks to. Groq answers when it can; when it
// is slow, unreachable, rate-limited or erroring, a local model answers
// instead, and Groq is left alone for a while so every turn does not pay for
// rediscovering that it is down.

const PRIMARY = (process.env.LLM_PRIMARY || "groq").trim().toLowerCase();

// Short on purpose. Groq normally answers in well under a second, and every
// millisecond spent waiting on a Groq that is not coming is a millisecond the
// fallback no longer has inside Alexa's budget.
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 2000);

// Long on purpose. A local answer is the last resort, and if it outlives the
// turn deadline the route hands the turn to the job registry - it is still
// wanted, just not by Alexa.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 60000);

const BREAKER_COOLDOWN_MS = Number(process.env.BREAKER_COOLDOWN_MS || 60000);

// Names the SDK and fetch give a timed-out or aborted request.
const TIMEOUT_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "APIConnectionTimeoutError",
  "APIUserAbortError",
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const nameOf = (error) => error?.constructor?.name ?? error?.name;

// Why a failure is worth failing over for, or null when it is not. A 400 or a
// 401 is a bug or a bad key - the fallback would not fix it, and quietly
// answering from it would hide that something needs fixing.
export const classifyFailure = (error) => {
  if (!error) return null;
  if (error.kind === "timeout") return "timeout";

  const status = error.status;

  if (status === 429) return "rate-limited";
  if (typeof status === "number" && status >= 500) return `server error ${status}`;
  if (typeof status === "number") return null;

  if (TIMEOUT_NAMES.has(error.name) || TIMEOUT_NAMES.has(nameOf(error))) return "timeout";

  if (
    nameOf(error) === "APIConnectionError" ||
    NETWORK_CODES.has(error.code) ||
    NETWORK_CODES.has(error.cause?.code) ||
    (error instanceof TypeError && /fetch failed/i.test(error.message))
  ) {
    return "network error";
  }

  return null;
};

// "18.7275s", "1m30.5s", "2h13m", "450ms" - Groq's own wording in a 429 body.
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000 };

const parseDuration = (text) => {
  let total = 0;
  let matched = false;

  for (const [, value, unit] of text.matchAll(DURATION_PART)) {
    total += Number(value) * UNIT_MS[unit];
    matched = true;
  }

  return matched ? total : null;
};

const headerOf = (error, name) => {
  const headers = error?.headers;

  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);

  return headers[name] ?? null;
};

// How long a 429 asked us to stay away, in ms, or null when it did not say.
// The headers are the contract; the "try again in" text is Groq's message,
// read only when no header came with it. Exported for the tests.
export const retryAfterMs = (error, now = Date.now()) => {
  if (error?.status !== 429) return null;

  const precise = Number(headerOf(error, "retry-after-ms"));

  if (precise > 0) return precise;

  const header = headerOf(error, "retry-after");

  if (header) {
    const seconds = Number(header);

    if (seconds > 0) return seconds * 1000;

    // An HTTP date is also a valid retry-after.
    const until = Date.parse(header);

    if (!Number.isNaN(until) && until > now) return until - now;
  }

  const said = /try again in\s+([\d.hms]+)/i.exec(error.message ?? "");

  return said ? parseDuration(said[1]) : null;
};

// Bounded here, not only in the provider: the signal asks the request to stop,
// and the race makes sure the turn moves on whether or not it does.
const callWithTimeout = async (provider, messages, tools) => {
  const controller = new AbortController();
  const elapsed = startTimer();
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${provider.name} timed out after ${provider.timeoutMs}ms`);
      error.kind = "timeout";

      // Rejected before aborting, so the race settles on this error rather
      // than on the provider's own, vaguer "request was aborted".
      reject(error);
      controller.abort();
    }, provider.timeoutMs);
  });

  try {
    const result = await Promise.race([
      provider.complete({ messages, tools, signal: controller.signal }),
      timeout,
    ]);

    return { ...result, latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
  }
};

// Exported as a factory so the tests can hand it fake providers and a clock.
export const createLLMService = ({
  primary,
  fallback = null,
  cooldownMs = BREAKER_COOLDOWN_MS,
  now = Date.now,
}) => {
  // The breaker is a timestamp: until then the primary is skipped. After it,
  // the next call tries the primary again, and a failure re-opens it.
  let openUntil = 0;

  const generate = async (messages, { tools } = {}) => {
    let fallbackReason = null;

    if (fallback && now() < openUntil) {
      fallbackReason = "breaker open";
      log(
        `[LLM ] skipping ${primary.name}, breaker open for another`,
        `${Math.ceil((openUntil - now()) / 1000)}s`,
      );
    } else {
      try {
        const result = await callWithTimeout(primary, messages, tools);

        if (openUntil) {
          log(`[LLM ] ${primary.name} answered again - breaker closed`);
          openUntil = 0;
        }

        return { ...result, provider: primary.name, fallbackReason: null };
      } catch (error) {
        const reason = classifyFailure(error);

        if (!fallback || !reason) {
          logError(`[LLM ] ${primary.name} failed, not failing over: ${error.message}`);
          throw error;
        }

        // A 429 that says when to come back is believed: shorter than the
        // fixed cooldown means Groq is back sooner, longer means asking
        // before then would only collect another 429.
        const askedFor = retryAfterMs(error, now());
        const cooldown = askedFor ?? cooldownMs;

        openUntil = now() + cooldown;
        fallbackReason = reason;

        logWarn(
          `[LLM ] ${primary.name} ${reason} (${preview(error.message, 160)}) - falling back to`,
          `${fallback.name}, skipping ${primary.name} for ${Math.round(cooldown / 100) / 10}s`,
          askedFor !== null ? "(retry-after)" : "",
        );
      }
    }

    try {
      const result = await callWithTimeout(fallback, messages, tools);

      return { ...result, provider: fallback.name, fallbackReason };
    } catch (error) {
      logError(`[LLM ] fallback ${fallback.name} failed too: ${error.message}`);
      throw error;
    }
  };

  return {
    generate,
    isBreakerOpen: () => now() < openUntil,
  };
};

const groq = createGroqProvider({ timeoutMs: GROQ_TIMEOUT_MS });
const ollama = createOllamaProvider({ timeoutMs: OLLAMA_TIMEOUT_MS });

const service =
  PRIMARY === "ollama"
    ? createLLMService({ primary: ollama, fallback: groq })
    : createLLMService({ primary: groq, fallback: ollama });

// Called once at boot, so neither provider's first real turn is a cold one:
// Ollama loads the model into memory, Groq makes one tiny call. Opt out of
// either with GROQ_WARMUP=false or OLLAMA_WARMUP=false.
export const warmUpProviders = () =>
  Promise.all([
    process.env.GROQ_WARMUP === "false" ? false : groq.warmUp(),
    process.env.OLLAMA_WARMUP === "false" ? false : ollama.warmUp(),
  ]);

// Spoken when a reply was meant to be a tool call but could not be used as one.
export const MALFORMED_TOOL_REPLY =
  "Sorry, I couldn't work out how to do that. Could you say it another way?";

const parseArguments = (raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// A tool call the loop can actually run, normalised, or null. Small local
// models get this wrong in ways Groq does not: arguments that are not JSON, a
// tool that does not exist, a call with no id - and the missing id is the one
// that hurts, because the follow-up request is then rejected outright.
const repairToolCall = (call, index, toolNames) => {
  const name = call?.function?.name;

  if (typeof name !== "string" || !toolNames.has(name)) return null;

  const args = parseArguments(call.function.arguments);

  if (!args) return null;

  return {
    id: typeof call.id === "string" && call.id ? call.id : `call_${Date.now()}_${index}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
};

// A tool call written into the text instead of the tool_calls field - raw
// JSON or Qwen's own tags. Spoken as it is, Alexa would read out braces.
const LEAKED_TOOL_CALL = /<\/?tool_call>|^\s*[[{][\s\S]*"(?:name|arguments|function)"\s*:/;

// Whatever the provider sent, something the turn loop can use: tool calls it
// can run, or text it can speak. Exported for the tests.
export const sanitizeReply = (message, tools = []) => {
  const toolNames = new Set(tools.map((tool) => tool?.function?.name).filter(Boolean));
  const requested = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  if (requested.length) {
    const usable = requested
      .map((call, index) => repairToolCall(call, index, toolNames))
      .filter(Boolean);

    if (usable.length < requested.length) {
      logWarn(
        `[LLM ] dropped ${requested.length - usable.length} of ${requested.length} malformed tool call(s):`,
        preview(requested, 300),
      );
    }

    if (usable.length) {
      return { ...message, tool_calls: usable };
    }
  }

  const { tool_calls: _dropped, ...rest } = message;
  const content = typeof message.content === "string" ? message.content.trim() : "";

  if (requested.length || LEAKED_TOOL_CALL.test(content)) {
    if (!requested.length) {
      logWarn(`[LLM ] tool call leaked into the text, not speaking it: ${preview(content, 200)}`);
    }

    return { ...rest, content: MALFORMED_TOOL_REPLY };
  }

  return rest;
};

// Returns the full assistant message so a reply carrying tool_calls survives
// to the caller. Speak `.content`; store the whole object in memory.
// `provider` and `latencyMs` ride along for the turn log; addAssistantMessage
// keeps only content and tool_calls, so they never reach the history.
export const generateAIReply = async (chatMemory, { tools } = {}) => {
  const messages = buildMessages(chatMemory);

  log(
    `[LLM ] -> messages=${messages.length}`,
    `tools=${tools?.length ?? 0}`,
    `last="${preview(messages[messages.length - 1]?.content ?? "(tool result)", 120)}"`,
  );

  const { message: raw, usage = {}, finishReason, provider, latencyMs, fallbackReason } =
    await service.generate(messages, { tools });
  const message = raw ? sanitizeReply(raw, tools) : raw;

  log(
    `[LLM ] <- ${provider} ${latencyMs}ms`,
    fallbackReason ? `(fallback: ${fallbackReason})` : "",
    `prompt=${usage?.prompt_tokens ?? "?"}`,
    `completion=${usage?.completion_tokens ?? "?"}`,
    `reasoning=${usage?.completion_tokens_details?.reasoning_tokens ?? 0}`,
    `finish=${finishReason ?? "?"}`,
  );

  const meta = { provider, latencyMs };

  if (!message) {
    logError(`[LLM ] ${provider} response contained no message`);
    return { role: "assistant", content: "Sorry, I didn't get that.", ...meta };
  }

  // A tool_calls reply has null content by design - it is a request to act,
  // not something to speak. Only fall back when there is nothing at all.
  if (message.tool_calls?.length) {
    log(
      `[LLM ] requested ${message.tool_calls.length} tool call(s): ` +
        message.tool_calls.map((call) => call.function?.name).join(", "),
    );

    return { ...message, content: message.content?.trim() || null, ...meta };
  }

  return {
    ...message,
    content: message.content?.trim() || "Sorry, I didn't get that.",
    ...meta,
  };
};
