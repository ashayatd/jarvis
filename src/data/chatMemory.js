export const SYSTEM_PROMPT = `You are AI mode, a smart and conversational voice assistant.

Your replies are spoken aloud by Alexa, so:
- Answer the user's actual question directly.
- Normally answer in 2-5 sentences. Be concise but never cut a sentence short.
- Write plain spoken prose. No markdown, bullet points, or emoji.
- If the user asks for a list of N things, give exactly N.
- Follow the user's lead on topic changes and resolve references like "the second one" against the conversation above.`;

export const createChatMemory = () => ({
  messages: [],
});

export const resetChatHistory = (memory) => {
  memory.messages = [];
};

export const addUserMessage = (memory, content) => {
  memory.messages.push({ role: "user", content });
};

// Accepts either a plain string or a full assistant message from the API,
// so a reply carrying tool_calls is stored intact.
export const addAssistantMessage = (memory, message) => {
  const { content = null, tool_calls } =
    typeof message === "string" ? { content: message } : message;

  memory.messages.push({
    role: "assistant",
    content,
    ...(tool_calls?.length ? { tool_calls } : {}),
  });
};

export const addToolResult = (memory, toolCallId, content) => {
  memory.messages.push({
    role: "tool",
    tool_call_id: toolCallId,
    content: typeof content === "string" ? content : JSON.stringify(content),
  });
};

// The system prompt is prepended at send time, never stored in history,
// so it stays single-sourced and can't be trimmed away.
export const buildMessages = (memory) => [
  { role: "system", content: SYSTEM_PROMPT },
  ...memory.messages,
];

// Keeps the window starting on a user turn. Slicing blindly can strand a
// `tool` message whose parent assistant tool_calls fell off the front,
// which the API rejects.
export const trimHistory = (memory, maxMessages = 20) => {
  if (memory.messages.length <= maxMessages) return;

  const trimmed = memory.messages.slice(-maxMessages);

  while (trimmed.length && trimmed[0].role !== "user") {
    trimmed.shift();
  }

  memory.messages = trimmed;
};
