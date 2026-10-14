import { log, logError, logWarn, preview, startTimer } from "../../utils/logger.js";

// A local model through Ollama's OpenAI-compatible endpoint, so it takes the
// same messages and tool schemas as Groq and answers in the same shape. Plain
// fetch rather than an SDK: it is one POST.
export const createOllamaProvider = ({
  baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  model = process.env.OLLAMA_MODEL || "qwen2.5:3b",
  // How long the model stays in memory after a call. Loading it from disk
  // takes longer than a turn can spare, so a fallback that finds it unloaded
  // is a fallback that cannot answer in time. "-1" keeps it loaded
  // indefinitely.
  keepAlive = process.env.OLLAMA_KEEP_ALIVE || "30m",
  // Only for a reasoning model such as gpt-oss, where every reasoning token is
  // time the user is waiting - "low" is what fits a spoken turn. Not sent when
  // unset, because a model that does not reason has no use for it.
  reasoningEffort = process.env.OLLAMA_REASONING_EFFORT || null,
  // Set above Groq's 300 because a reasoning model spends part of it before
  // the answer starts.
  maxTokens = Number(process.env.OLLAMA_MAX_TOKENS || 1024),
  timeoutMs,
} = {}) => {
  const root = baseUrl.replace(/\/+$/, "");

  // keep_alive is native Ollama; the warm-up uses the native API, which is
  // where it is guaranteed to be honoured.
  const nativeRoot = root.replace(/\/v1$/, "");

  return {
    name: "ollama",
    model,
    timeoutMs,
    complete: async ({ messages, tools, signal }) => {
      const response = await fetch(`${root}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
          temperature: 0.7,
          max_tokens: maxTokens,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          keep_alive: keepAlive,
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`ollama returned ${response.status}: ${preview(body, 200)}`);

        error.status = response.status;
        throw error;
      }

      const completion = await response.json();

      return {
        message: completion.choices?.[0]?.message,
        usage: completion.usage,
        finishReason: completion.choices?.[0]?.finish_reason,
      };
    },

    // Loads the model with no prompt, so the first real fallback does not pay
    // for reading it off disk. Best effort: a failure is logged, never thrown.
    warmUp: async ({ timeoutMs: warmTimeoutMs = 180000 } = {}) => {
      const elapsed = startTimer();

      log(`[OLMA] warming ${model} keep_alive=${keepAlive}`);

      try {
        const response = await fetch(`${nativeRoot}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, keep_alive: keepAlive }),
          signal: AbortSignal.timeout(warmTimeoutMs),
        });

        if (!response.ok) {
          logWarn(`[OLMA] warm-up got ${response.status} after ${elapsed()}ms: ${preview(await response.text(), 200)}`);
          return false;
        }

        log(`[OLMA] ${model} loaded in ${elapsed()}ms`);
        return true;
      } catch (error) {
        logError(`[OLMA] warm-up failed after ${elapsed()}ms: ${error.message}`);
        return false;
      }
    },
  };
};
