// A small local model gets tool calls wrong in ways Groq does not. Whatever it
// sends, the turn must end in something Alexa can say - never a crash, never
// JSON read aloud. The provider is mocked at the module boundary so the real
// llmService and route run between it and the speaker.
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

process.env.EXECUTOR_URL = "http://127.0.0.1:9/execute";
process.env.LLM_PRIMARY = "groq";

// Each call takes the next scripted message.
const scripted = [];

const mockProvider = (name) => ({ timeoutMs }) => ({
  name,
  timeoutMs,
  complete: async () => {
    if (!scripted.length) {
      throw new Error(`${name} called with no scripted reply left`);
    }

    return { message: scripted.shift(), usage: {}, finishReason: "stop" };
  },
  warmUp: async () => true,
});

mock.module(new URL("../src/services/providers/groqProvider.js", import.meta.url).href, {
  namedExports: { createGroqProvider: mockProvider("groq") },
});

mock.module(new URL("../src/services/providers/ollamaProvider.js", import.meta.url).href, {
  namedExports: { createOllamaProvider: mockProvider("ollama") },
});

const { default: app } = await import("../src/app.js");
const { MALFORMED_TOOL_REPLY, sanitizeReply } = await import("../src/services/llmService.js");
const { toolSchemas } = await import("../src/tools/registry.js");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/alexa`;
});

after(() => server?.close());

const say = async (sessionId, text) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session: { sessionId },
      request: { type: "IntentRequest", intent: { slots: { q: { value: text } } } },
    }),
  });

  const body = await res.json();

  return {
    status: res.status,
    text: (body.response.outputSpeech.ssml ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/&#39;|&apos;/g, "'")
      .trim(),
    end: body.response.shouldEndSession,
  };
};

const call = (name, args, id = "call_1") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

const toolReply = (...calls) => ({ role: "assistant", content: null, tool_calls: calls });

// --- through a real turn ---------------------------------------------------

for (const [label, message] of [
  ["arguments that are not JSON", toolReply(call("open_project", '{"project": "landing page"'))],
  ["arguments that are a JSON string, not an object", toolReply(call("open_project", '"landing page"'))],
  ["a tool that does not exist", toolReply(call("open_vscode_now", '{"project":"x"}'))],
  ["a call with no function at all", toolReply({ id: "call_1", type: "function" })],
  ["a null tool_calls entry", toolReply(null)],
  [
    "a tool call written into the text as JSON",
    { role: "assistant", content: '{"name": "open_project", "arguments": {"project": "landing page"}}' },
  ],
  [
    "a tool call written into the text in qwen's tags",
    {
      role: "assistant",
      content: '<tool_call>\n{"name": "check_background_jobs", "arguments": {}}\n</tool_call>',
    },
  ],
]) {
  test(`${label} becomes a plain spoken reply, not a crash`, async () => {
    scripted.length = 0;
    scripted.push(message);

    const turn = await say(`malformed-${label}`, "open the landing page project");

    assert.equal(turn.status, 200);
    assert.equal(turn.text, MALFORMED_TOOL_REPLY);
    assert.equal(turn.end, false, "the mic stays open so the user can try again");
    assert.equal(scripted.length, 0, "no second model call should have been needed");
  });
}

test("the session still works normally on the next turn", async () => {
  scripted.length = 0;
  scripted.push(toolReply(call("open_project", "{broken")));
  await say("malformed-then-fine", "open the landing page");

  scripted.push({ role: "assistant", content: "It is Thursday." });

  const turn = await say("malformed-then-fine", "what day is it");

  assert.equal(turn.text, "It is Thursday.");
});

// --- the repair itself -----------------------------------------------------

test("valid tool calls pass through untouched", () => {
  const message = toolReply(call("check_directory", '{"project":"landing page"}'));

  assert.deepEqual(sanitizeReply(message, toolSchemas).tool_calls, message.tool_calls);
});

test("a malformed call is dropped and a valid one beside it is kept", () => {
  const good = call("check_directory", '{"project":"landing page"}', "call_good");
  const result = sanitizeReply(toolReply(call("open_project", "{nope", "call_bad"), good), toolSchemas);

  assert.deepEqual(result.tool_calls, [good]);
});

test("small slips are repaired rather than thrown away", () => {
  // Arguments sent as an object instead of a string, no id, and empty
  // arguments for a tool that takes none - all usable.
  const result = sanitizeReply(
    toolReply(
      { type: "function", function: { name: "check_directory", arguments: { project: "notes" } } },
      { function: { name: "check_background_jobs", arguments: "" } },
    ),
    toolSchemas,
  );

  assert.equal(result.tool_calls.length, 2);
  assert.equal(result.tool_calls[0].function.arguments, '{"project":"notes"}');
  assert.equal(result.tool_calls[1].function.arguments, "{}");
  assert.ok(result.tool_calls.every((entry) => typeof entry.id === "string" && entry.id));
  assert.notEqual(result.tool_calls[0].id, result.tool_calls[1].id);
});

test("ordinary prose is left alone", () => {
  for (const content of [
    "It is Thursday.",
    "The server is running on port 5173.",
    "Your project is named {landing page}.",
  ]) {
    assert.equal(sanitizeReply({ role: "assistant", content }, toolSchemas).content, content);
  }
});
