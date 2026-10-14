// The Ollama provider against a stub server: what it sends, what it hands
// back, and the warm-up that keeps the model loaded.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { classifyFailure } from "../src/services/llmService.js";
import { createOllamaProvider } from "../src/services/providers/ollamaProvider.js";
import { toolSchemas } from "../src/tools/registry.js";

const requests = [];
let status = 200;
let reply = {};

const stub = http.createServer((req, res) => {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

let baseUrl;

before(async () => {
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${stub.address().port}/v1`;
});

after(() => stub.close());

const provider = () =>
  createOllamaProvider({ baseUrl, model: "qwen2.5:3b", keepAlive: "30m", timeoutMs: 1000 });

test("a completion goes to the OpenAI-compatible endpoint with keep_alive and the tools", async () => {
  requests.length = 0;
  status = 200;

  const toolCall = {
    id: "call_1",
    type: "function",
    function: { name: "check_directory", arguments: '{"project":"landing page"}' },
  };

  reply = {
    choices: [{ message: { role: "assistant", content: "", tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };

  const messages = [
    { role: "system", content: "You are Pluto." },
    { role: "user", content: "open landing page" },
  ];

  const result = await provider().complete({ messages, tools: toolSchemas });

  const [sent] = requests;

  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.body.model, "qwen2.5:3b");
  assert.equal(sent.body.keep_alive, "30m");
  assert.equal(sent.body.tool_choice, "auto");
  assert.deepEqual(sent.body.messages, messages);
  assert.deepEqual(sent.body.tools, toolSchemas);

  // The same shape Groq returns, so nothing downstream can tell them apart.
  assert.deepEqual(result.message.tool_calls, [toolCall]);
  assert.equal(result.finishReason, "tool_calls");
});

test("an error status is thrown with the status attached, so failover can read it", async () => {
  status = 503;
  reply = { error: "model is loading" };

  await assert.rejects(provider().complete({ messages: [] }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(classifyFailure(error), "server error 503");
    return true;
  });

  status = 200;
});

test("warm-up loads the model through the native API with keep_alive", async () => {
  requests.length = 0;
  status = 200;
  reply = { done: true };

  assert.equal(await provider().warmUp(), true);

  const [sent] = requests;

  assert.equal(sent.url, "/api/generate");
  assert.deepEqual(sent.body, { model: "qwen2.5:3b", keep_alive: "30m" });
});

test("a failed warm-up is reported, not thrown", async () => {
  const unreachable = createOllamaProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "x" });

  assert.equal(await unreachable.warmUp({ timeoutMs: 2000 }), false);
});
