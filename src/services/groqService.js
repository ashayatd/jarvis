import Groq from "groq-sdk";
import { buildConversationPrompt } from "../data/chatMemory.js";

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

export const generateAIReply = async (chatMemory) => {
  const groq = getGroqClient();

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [
      {
        role: "system",
        content: "You are a smart AI assistant.",
      },
      {
        role: "user",
        content: buildConversationPrompt(chatMemory),
      },
    ],
    temperature: 0.7,
    max_tokens: 120,
  });

  return completion.choices[0]?.message?.content || "Sorry, I didn't get that.";
};
