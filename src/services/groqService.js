import Groq from "groq-sdk";
import { buildMessages } from "../data/chatMemory.js";
import { log, logError, preview, startTimer } from "../utils/logger.js";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

let groqClient = null;

const getGroqClient = () => {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is missing. Add it to your .env file before calling the AI endpoint.",
    );
  }

  if (!groqClient) {
    groqClient = new Groq({ apiKey });
    log(`[GROQ] client created model=${MODEL}`);
  }

  return groqClient;
};

// Returns the full assistant message so a reply carrying tool_calls survives
// to the caller. Speak `.content`; store the whole object in memory.
export const generateAIReply = async (chatMemory, { tools } = {}) => {
  const groq = getGroqClient();
  const messages = buildMessages(chatMemory);
  const elapsed = startTimer();

  log(
    `[GROQ] -> model=${MODEL} messages=${messages.length}`,
    `tools=${tools?.length ?? 0}`,
    `last="${preview(messages[messages.length - 1]?.content ?? "(tool result)", 120)}"`,
  );

  let completion;

  try {
    completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.7,
      max_tokens: 300,
    });
  } catch (error) {
    logError(`[GROQ] call failed after ${elapsed()}ms: ${error.message}`);
    throw error;
  }

  const usage = completion.usage ?? {};

  log(
    `[GROQ] <- ${elapsed()}ms`,
    `prompt=${usage.prompt_tokens ?? "?"}`,
    `completion=${usage.completion_tokens ?? "?"}`,
    `reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 0}`,
    `finish=${completion.choices?.[0]?.finish_reason ?? "?"}`,
  );

  const message = completion.choices[0]?.message;

  if (!message) {
    logError("[GROQ] response contained no message");
    return { role: "assistant", content: "Sorry, I didn't get that." };
  }

  // A tool_calls reply has null content by design - it is a request to act,
  // not something to speak. Only fall back when there is nothing at all.
  if (message.tool_calls?.length) {
    log(
      `[GROQ] requested ${message.tool_calls.length} tool call(s): ` +
        message.tool_calls.map((call) => call.function?.name).join(", "),
    );

    return { ...message, content: message.content?.trim() || null };
  }

  return {
    ...message,
    content: message.content?.trim() || "Sorry, I didn't get that.",
  };
};
