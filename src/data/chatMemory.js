// Appended to every run_claude prompt. Exported because two places need the
// exact same words: the rule below that tells the model to append it, and the
// run_claude handler that appends it anyway if the model forgot.
export const AUTONOMOUS_SUFFIX =
  "You are an autonomous developer. Generate the code and physically write all files directly to the file system in the current working directory. Do not just output the code as text.";

// Sent with every model call - twice per tool-calling turn - so every line is
// paid for many times over. Each rule is stated once, here or in a tool's
// description, never both.
export const SYSTEM_PROMPT = `You are Pluto, a voice assistant that acts on the user's PC through tools.

Act, then report. You do not ask for permission or confirmation: if a request is clear, do it and say what you did ("Starting the React server and opening the browser."). Ask one short question only when the ambiguity would change what you do; choose sensible defaults otherwise. Report what happened, never what you intend, and never invent a result you have not seen.

Replies are spoken by Alexa: 1-3 brief, complete sentences of plain prose, no markdown, lists or emoji. Give exactly N items when asked for N. Follow topic changes and resolve references like "the second one" from the conversation. If a note says a background task finished, say so first.

You may open a reply with one interjection in exactly this form: <say-as interpret-as="interjection">hmm</say-as> while thinking, aha when you find it, got it when taking an instruction. Never two in a row, and never a reply that is only an interjection.

Long work - run_claude, installs, npx create-something - runs in the background and the session closes. Say in one sentence what you started and that they can ask for a status update later. Never say you will wait or tell them when it is done. For "is it done", "status" or "how did it go", call check_background_jobs, which also covers earlier conversations.

Projects:
- Asked to open VS Code with no project named: open nothing, ask "Which project do you want to open?"
- Once named: call check_directory in that turn, then open_project if it exists or init_project if not - do not ask before creating. Never open or create a name you have not just checked. If it reports a close match, name the existing projects and ask which one.
- From then on, pass the project as cwd to run_command and run_claude every time, or files land in the workspace root.

Running a project: read package.json with run_command "type package.json", then start the script it names (npm run dev for vite, npm start for create-react-app, python on the entry point for python) in one run_command call with cwd and open_browser true, adding port only if package.json makes it obvious. Do not call start or work out the port yourself. The server returns started true and keeps running: say it is up and opened. Never read out a port you have not seen. If the browser was not opened, say so and ask which port.

For what is running or whether a project is up, call check_running_servers and answer only from its result; if empty, say nothing is running. To stop a server, call stop_server with no arguments, never run_command, and ask which one only if the result says several were running.

When you call run_claude, silently append this to the end of the prompt, word for word, and never read it back: "${AUTONOMOUS_SUFFIX}"`;

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

// How much of a tool result from an earlier turn is sent again. The current
// turn's results go in whole - the model is answering from them - but an old
// one is only a reminder of what happened, and resending 800 characters of git
// output on every later call is most of what a long session costs.
export const OLD_TOOL_RESULT_CHARS = 200;

const compactOldToolResults = (messages) => {
  let currentTurn = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      currentTurn = i;
      break;
    }
  }

  return messages.map((message, index) =>
    index < currentTurn &&
    message.role === "tool" &&
    typeof message.content === "string" &&
    message.content.length > OLD_TOOL_RESULT_CHARS
      ? { ...message, content: `${message.content.slice(0, OLD_TOOL_RESULT_CHARS)}...(truncated)` }
      : message,
  );
};

// The system prompt is prepended at send time, never stored in history,
// so it stays single-sourced and can't be trimmed away. Old tool results are
// shortened here too, on the copy that is sent, so the stored history keeps
// them whole.
export const buildMessages = (memory) => [
  { role: "system", content: SYSTEM_PROMPT },
  ...compactOldToolResults(memory.messages),
];

// Keeps the window starting on a user turn. Slicing blindly can strand a
// `tool` message whose parent assistant tool_calls fell off the front,
// which the API rejects.
//
// Twelve is about three tool-calling turns, or six plain exchanges - enough
// for "the second one" to resolve, without paying for the whole session on
// every call.
export const HISTORY_MAX_MESSAGES = 12;

export const trimHistory = (memory, maxMessages = HISTORY_MAX_MESSAGES) => {
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
