// What a long session costs per call: old tool results are shortened on the
// way out, and the stored window is twelve messages, always starting on a user
// turn so no tool result is stranded without the call that asked for it.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addAssistantMessage,
  addToolResult,
  addUserMessage,
  buildMessages,
  createChatMemory,
  HISTORY_MAX_MESSAGES,
  OLD_TOOL_RESULT_CHARS,
  SYSTEM_PROMPT,
  trimHistory,
} from "../src/data/chatMemory.js";

const longOutput = "x".repeat(800);

// One tool-calling exchange: user, assistant asking for a tool, the result,
// and the spoken answer.
const exchange = (memory, n, { answered = true } = {}) => {
  addUserMessage(memory, `question ${n}`);
  addAssistantMessage(memory, {
    content: null,
    tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "run_command", arguments: "{}" } }],
  });
  addToolResult(memory, `call_${n}`, { ok: true, output: longOutput });

  if (answered) addAssistantMessage(memory, `answer ${n}`);
};

test("old tool results are shortened when sent; the current turn's are whole", () => {
  const memory = createChatMemory();

  exchange(memory, 1);
  exchange(memory, 2, { answered: false });

  const sent = buildMessages(memory);
  const tools = sent.filter((message) => message.role === "tool");

  assert.equal(sent[0].content, SYSTEM_PROMPT);
  assert.equal(tools.length, 2);
  assert.ok(tools[0].content.length <= OLD_TOOL_RESULT_CHARS + 20, "earlier turn is shortened");
  assert.match(tools[0].content, /\(truncated\)$/);
  assert.ok(tools[1].content.includes(longOutput), "current turn is sent whole");

  // Pairing survives: every tool message still follows the call that asked.
  assert.equal(tools[0].tool_call_id, "call_1");
  assert.equal(tools[1].tool_call_id, "call_2");
});

test("shortening never touches the stored history", () => {
  const memory = createChatMemory();

  exchange(memory, 1);
  exchange(memory, 2);
  buildMessages(memory);

  const stored = memory.messages.filter((message) => message.role === "tool");

  assert.ok(stored.every((message) => message.content.includes(longOutput)));
});

test("short tool results and other messages are sent unchanged", () => {
  const memory = createChatMemory();

  addUserMessage(memory, "first");
  addAssistantMessage(memory, {
    content: null,
    tool_calls: [{ id: "c", type: "function", function: { name: "check_directory", arguments: "{}" } }],
  });
  addToolResult(memory, "c", { ok: true, exists: true });
  addAssistantMessage(memory, "It exists.");
  addUserMessage(memory, "second");

  assert.deepEqual(buildMessages(memory).slice(1), memory.messages);
});

test("history keeps the last twelve messages, starting on a user turn", () => {
  const memory = createChatMemory();

  for (let n = 1; n <= 6; n++) exchange(memory, n);

  trimHistory(memory);

  assert.equal(HISTORY_MAX_MESSAGES, 12);
  assert.ok(memory.messages.length <= HISTORY_MAX_MESSAGES);
  assert.equal(memory.messages[0].role, "user");
  assert.equal(memory.messages[0].content, "question 4");
  assert.equal(memory.messages.at(-1).content, "answer 6");
});
