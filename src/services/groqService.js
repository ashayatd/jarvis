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

//   const completion = await groq.chat.completions.create({
//     model: "openai/gpt-oss-20b",
//     messages: [
//       {
//         role: "system",
//         content: "You are a smart AI assistant.",
//       },
//       {
//         role: "user",
//         content: buildConversationPrompt(chatMemory),
//       },
//     ],
//     temperature: 0.7,
//     max_tokens: 120,
//   });

const completion = await groq.chat.completions.create({
  model: "openai/gpt-oss-20b",
  messages: [
    {
      role: "system",
      content: `
            You are AI mode, a smart and conversational voice assistant.

            Rules:
            - Answer the user's actual question.
            - Keep answers concise but complete.
            - Do not cut sentences short.
            - Since the response will be spoken by Alexa, avoid very long answers.
            - Normally answer in 2-5 sentences.
            - If the user asks for a list, provide the requested number of items.
      `,
    },
    {
      role: "user",
      content: prompt,
    },
  ],
  temperature: 0.7,
  max_tokens: 300,
});

  return completion.choices[0]?.message?.content || "Sorry, I didn't get that.";
};
