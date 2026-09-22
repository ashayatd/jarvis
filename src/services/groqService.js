import Groq from "groq-sdk";
import { buildMessages } from "../data/chatMemory.js";

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
  }

  return groqClient;
};

// Returns the full assistant message so a reply carrying tool_calls survives
// to the caller. Speak `.content`; store the whole object in memory.
export const generateAIReply = async (chatMemory, { tools } = {}) => {
  const groq = getGroqClient();

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: buildMessages(chatMemory),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    temperature: 0.7,
    max_tokens: 300,
  });

  const message = completion.choices[0]?.message;

  if (!message) {
    return { role: "assistant", content: "Sorry, I didn't get that." };
  }

  // A tool_calls reply has null content by design - it is a request to act,
  // not something to speak. Only fall back when there is nothing at all.
  if (message.tool_calls?.length) {
    return { ...message, content: message.content?.trim() || null };
  }

  return {
    ...message,
    content: message.content?.trim() || "Sorry, I didn't get that.",
  };
};
