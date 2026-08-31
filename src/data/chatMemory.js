export const createChatMemory = () => ({
  history: [],
});

export const resetChatHistory = (memory) => {
  memory.history = [];
};

export const addUserMessage = (memory, message) => {
  memory.history.push(`User: ${message}`);
};

export const addAssistantMessage = (memory, message) => {
  memory.history.push(`AI: ${message}`);
};

export const trimHistory = (memory, maxEntries = 20) => {
  if (memory.history.length > maxEntries) {
    memory.history = memory.history.slice(-maxEntries);
  }
};

export const buildConversationPrompt = (memory) => `
You are AI mode, a smart and conversational assistant.

Conversation history:
${memory.history.join("\n")}

Important behavior rules:
- Maintain conversational context naturally
- If the user changes topic, immediately switch topics
- Never force old topics into new conversations
- If the user says things like:
  "forget that",
  "new topic",
  "let's talk about something else",
  "I don't want to continue"
  then stop using previous topic context
- Keep responses short and voice-friendly for Alexa
- Understand references like "I choose 1"

Respond naturally to the latest user message only.
`;
