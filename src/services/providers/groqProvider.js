import Groq from "groq-sdk";
import { log, logError, startTimer } from "../../utils/logger.js";

// One chat-completions call against Groq. Timeouts, failover and logging belong
// to llmService; this only speaks Groq and hands back the raw message.
export const createGroqProvider = ({
  model = process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  timeoutMs,
} = {}) => {
  let client = null;

  // Read at call time rather than creation, so importing this before .env is
  // loaded still finds the key.
  const getClient = () => {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      throw new Error(
        "GROQ_API_KEY is missing. Add it to your .env file before calling the AI endpoint.",
      );
    }

    if (!client) {
      // No retries. The SDK retries 429s and 5xxs twice by default, which would
      // spend the whole failover budget waiting on the provider that is
      // already failing.
      client = new Groq({ apiKey, maxRetries: 0 });
      log(`[GROQ] client created model=${model}`);
    }

    return client;
  };

  return {
    name: "groq",
    model,
    timeoutMs,
    complete: async ({ messages, tools, signal }) => {
      const completion = await getClient().chat.completions.create(
        {
          model,
          messages,
          ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
          temperature: 0.7,
          max_tokens: 300,
        },
        { signal, maxRetries: 0 },
      );

      return {
        message: completion.choices?.[0]?.message,
        usage: completion.usage,
        finishReason: completion.choices?.[0]?.finish_reason,
      };
    },

    // One token, so the first real turn does not pay for creating the client,
    // resolving and connecting - the first call of a session has been measured
    // at over 4s, past the failover timeout. Best effort: logged, never thrown.
    warmUp: async ({ timeoutMs: warmTimeoutMs = 15000 } = {}) => {
      const elapsed = startTimer();

      try {
        await getClient().chat.completions.create(
          { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
          { signal: AbortSignal.timeout(warmTimeoutMs), maxRetries: 0 },
        );

        log(`[GROQ] warmed up in ${elapsed()}ms`);
        return true;
      } catch (error) {
        logError(`[GROQ] warm-up failed after ${elapsed()}ms: ${error.message}`);
        return false;
      }
    },
  };
};
