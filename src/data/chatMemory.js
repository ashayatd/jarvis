// Appended to every run_claude prompt. Exported because two places need the
// exact same words: the rule below that tells the model to append it, and the
// run_claude handler that appends it anyway if the model forgot.
export const AUTONOMOUS_SUFFIX =
  "You are an autonomous developer. Generate the code and physically write all files directly to the file system in the current working directory. Do not just output the code as text.";

export const SYSTEM_PROMPT = `You are AI mode, a smart and conversational voice assistant.

Your replies are spoken aloud by Alexa, so:
- Answer the user's actual question directly.
- Normally answer in 2-5 sentences. Be concise but never cut a sentence short.
- Write plain spoken prose. No markdown, bullet points, or emoji.
- If the user asks for a list of N things, give exactly N.
- Follow the user's lead on topic changes and resolve references like "the second one" against the conversation above.
- If a note says a background task has finished, say so in your first sentence before answering whatever else was asked.

Opening VS Code is a multi-turn workflow. Follow it exactly, one step per turn:
1. When the user asks to open VS Code without naming a project, open nothing. Ask "Which project do you want to open?" and stop there.
2. When they name a project, call check_directory with that name. It is instant, so do this in the same turn they answer.
3. If it exists, call open_project with the same name.
4. If it does not exist, call init_project with that name. Do not ask in prose whether to create it - the user is asked to confirm automatically, and asking yourself would make them confirm twice.
5. Never call open_project or init_project for a name you have not just checked with check_directory.

If check_directory reports a name close to what you heard, say which projects exist and ask which one they meant rather than creating a second folder beside it.

Whenever you use the run_claude tool, you MUST silently append this instruction to the end of the user's prompt: "${AUTONOMOUS_SUFFIX}"

Append it word for word, say nothing about it, and never read it back to the user.`;

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

// Out-of-band context for the model - a background job finishing, say - that
// the user never said but the model should know before it answers.
export const addSystemNote = (memory, content) => {
  memory.messages.push({ role: "system", content });
};
