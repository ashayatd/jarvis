// Groq first, a local model when Groq cannot answer, and a breaker so a Groq
// outage is paid for once rather than on every turn. The providers are fakes
// and the clock is a variable, so every rule here can be hit on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyFailure, createLLMService, retryAfterMs } from "../src/services/llmService.js";

const MESSAGES = [{ role: "user", content: "what day is it" }];
const COOLDOWN_MS = 60000;

const answer = (content) => ({
  message: { role: "assistant", content },
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  finishReason: "stop",
});

// A provider whose next behaviour is set per test. `calls` counts how often it
// was actually asked, which is what the breaker tests are about.
const fakeProvider = (name, timeoutMs = 50) => {
  const provider = {
    name,
    timeoutMs,
    calls: 0,
    lastSignal: null,
    behaviour: async () => answer(`from ${name}`),
    complete: async (request) => {
      provider.calls += 1;
      provider.lastSignal = request.signal;
      return provider.behaviour(request);
    },
  };

  return provider;
};

// Never answers, but stops when told to, like a real request would.
const hang = ({ signal }) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

const httpError = (status) => async () => {
  const error = new Error(`status ${status}`);
  error.status = status;
  throw error;
};

const setup = () => {
  let clock = 1_000_000;
  const groq = fakeProvider("groq");
  const ollama = fakeProvider("ollama", 1000);
  const service = createLLMService({
    primary: groq,
    fallback: ollama,
    cooldownMs: COOLDOWN_MS,
    now: () => clock,
  });

  return {
    groq,
    ollama,
    service,
    advance: (ms) => {
      clock += ms;
    },
  };
};

test("groq answers when it can, and ollama is never asked", async () => {
  const { groq, ollama, service } = setup();

  const result = await service.generate(MESSAGES, { tools: [] });

  assert.equal(result.provider, "groq");
  assert.equal(result.message.content, "from groq");
  assert.equal(result.fallbackReason, null);
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(groq.calls, 1);
  assert.equal(ollama.calls, 0);
  assert.equal(service.isBreakerOpen(), false);
});

test("a groq timeout falls back to ollama, and the groq request is aborted", async () => {
  const { groq, ollama, service } = setup();
  groq.behaviour = hang;

  const started = Date.now();
  const result = await service.generate(MESSAGES);

  assert.equal(result.provider, "ollama");
  assert.equal(result.message.content, "from ollama");
  assert.equal(result.fallbackReason, "timeout");
  assert.equal(groq.lastSignal.aborted, true, "the abandoned request should be told to stop");
  assert.ok(Date.now() - started < 1000, "should move on at the groq timeout, not wait longer");
  assert.equal(ollama.calls, 1);
});

test("a groq that ignores the abort still cannot hold the turn past its timeout", async () => {
  const { groq, service } = setup();
  groq.behaviour = () => new Promise(() => {});

  const result = await service.generate(MESSAGES);

  assert.equal(result.provider, "ollama");
  assert.equal(result.fallbackReason, "timeout");
});

test("a groq 429 falls back to ollama", async () => {
  const { groq, ollama, service } = setup();
  groq.behaviour = httpError(429);

  const result = await service.generate(MESSAGES);

  assert.equal(result.provider, "ollama");
  assert.equal(result.fallbackReason, "rate-limited");
  assert.equal(ollama.calls, 1);
});

test("a groq 5xx and a network error both fall back", async () => {
  for (const [behaviour, reason] of [
    [httpError(503), "server error 503"],
    [httpError(500), "server error 500"],
    [
      async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
      "network error",
    ],
    [
      async () => {
        const error = new Error("getaddrinfo ENOTFOUND api.groq.com");
        error.code = "ENOTFOUND";
        throw error;
      },
      "network error",
    ],
  ]) {
    const { groq, service } = setup();
    groq.behaviour = behaviour;

    const result = await service.generate(MESSAGES);

    assert.equal(result.provider, "ollama", reason);
    assert.equal(result.fallbackReason, reason);
  }
});

test("a 400 or 401 is not failed over - it is a bug or a bad key, not an outage", async () => {
  for (const status of [400, 401, 404]) {
    const { ollama, groq, service } = setup();
    groq.behaviour = httpError(status);

    await assert.rejects(service.generate(MESSAGES), { status });
    assert.equal(ollama.calls, 0);
    assert.equal(service.isBreakerOpen(), false);
  }
});

test("an open breaker skips groq entirely", async () => {
  const { groq, ollama, service, advance } = setup();
  groq.behaviour = httpError(503);

  await service.generate(MESSAGES);
  assert.equal(service.isBreakerOpen(), true);
  assert.equal(groq.calls, 1);

  // Healthy again, but the breaker does not know that yet.
  groq.behaviour = async () => answer("from groq");
  advance(COOLDOWN_MS - 1);

  const result = await service.generate(MESSAGES);

  assert.equal(result.provider, "ollama");
  assert.equal(result.fallbackReason, "breaker open");
  assert.equal(groq.calls, 1, "groq must not be called while the breaker is open");
  assert.equal(ollama.calls, 2);
});

test("the breaker lets groq back in after the cooldown, and closes when it answers", async () => {
  const { groq, ollama, service, advance } = setup();
  groq.behaviour = httpError(429);

  await service.generate(MESSAGES);

  groq.behaviour = async () => answer("from groq");
  advance(COOLDOWN_MS);

  const result = await service.generate(MESSAGES);

  assert.equal(result.provider, "groq");
  assert.equal(groq.calls, 2);
  assert.equal(ollama.calls, 1);
  assert.equal(service.isBreakerOpen(), false);

  // Closed for good: the next call goes straight to groq too.
  assert.equal((await service.generate(MESSAGES)).provider, "groq");
});

test("a groq still failing after the cooldown re-opens the breaker", async () => {
  const { groq, service, advance } = setup();
  groq.behaviour = httpError(503);

  await service.generate(MESSAGES);
  advance(COOLDOWN_MS);

  const result = await service.generate(MESSAGES);

  assert.equal(result.provider, "ollama");
  assert.equal(result.fallbackReason, "server error 503");
  assert.equal(groq.calls, 2);
  assert.equal(service.isBreakerOpen(), true);
});

test("when both fail, the fallback's error reaches the caller", async () => {
  const { groq, ollama, service } = setup();
  groq.behaviour = httpError(503);
  ollama.behaviour = async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  };

  await assert.rejects(service.generate(MESSAGES), /fetch failed/);
});

test("both providers receive the same messages and tool schemas", async () => {
  const { groq, ollama, service, advance } = setup();
  const seen = [];
  const record = (name) => async ({ messages, tools }) => {
    seen.push({ name, messages, tools });
    return answer(name);
  };
  const tools = [{ type: "function", function: { name: "check_directory", parameters: {} } }];

  groq.behaviour = record("groq");
  await service.generate(MESSAGES, { tools });

  groq.behaviour = httpError(503);
  ollama.behaviour = record("ollama");
  advance(1);
  await service.generate(MESSAGES, { tools });

  assert.deepEqual(seen.map((entry) => entry.name), ["groq", "ollama"]);
  assert.deepEqual(seen[0].messages, seen[1].messages);
  assert.deepEqual(seen[0].tools, seen[1].tools);
});

test("classifyFailure only fails over on outages", () => {
  const withStatus = (status) => Object.assign(new Error("x"), { status });

  assert.equal(classifyFailure(Object.assign(new Error("x"), { kind: "timeout" })), "timeout");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })), "timeout");
  assert.equal(classifyFailure(withStatus(429)), "rate-limited");
  assert.equal(classifyFailure(withStatus(502)), "server error 502");
  assert.equal(classifyFailure(withStatus(400)), null);
  assert.equal(classifyFailure(withStatus(401)), null);
  assert.equal(classifyFailure(new Error("GROQ_API_KEY is missing.")), null);
});

// --- a 429 that says when to come back -----------------------------------

const rateLimited = ({ headers, message = "Rate limit reached." } = {}) => async () => {
  const error = new Error(`429 ${message}`);
  error.status = 429;
  error.headers = headers;
  throw error;
};

// Opens the breaker with `behaviour`, then reports whether groq is skipped
// just before `expectedMs` and asked again exactly at it.
const breakerLasts = async (behaviour, expectedMs) => {
  const { groq, service, advance } = setup();
  groq.behaviour = behaviour;

  await service.generate(MESSAGES);
  groq.behaviour = async () => answer("from groq");

  advance(expectedMs - 1);
  const before = (await service.generate(MESSAGES)).provider;

  advance(1);
  const at = (await service.generate(MESSAGES)).provider;

  return { before, at };
};

test("a 429 with retry-after opens the breaker for exactly that long", async () => {
  const short = await breakerLasts(rateLimited({ headers: new Headers({ "retry-after": "5" }) }), 5000);

  assert.deepEqual(short, { before: "ollama", at: "groq" }, "shorter than the fixed 60s");

  const long = await breakerLasts(rateLimited({ headers: new Headers({ "retry-after": "120" }) }), 120000);

  assert.deepEqual(long, { before: "ollama", at: "groq" }, "longer than the fixed 60s");
});

test("retry-after-ms is preferred, and a plain-object header map works too", async () => {
  const result = await breakerLasts(
    rateLimited({ headers: { "retry-after-ms": "2500", "retry-after": "9" } }),
    2500,
  );

  assert.deepEqual(result, { before: "ollama", at: "groq" });
});

test("with no header, Groq's 'try again in' wording is used", async () => {
  const result = await breakerLasts(
    rateLimited({ message: "Please try again in 18.7275s. Need more tokens?" }),
    18727.5,
  );

  assert.deepEqual(result, { before: "ollama", at: "groq" });
});

test("a 429 that names no time falls back to the fixed cooldown", async () => {
  const result = await breakerLasts(rateLimited(), COOLDOWN_MS);

  assert.deepEqual(result, { before: "ollama", at: "groq" });
});

test("retryAfterMs reads every form a 429 can take", () => {
  const limited = (fields) => Object.assign(new Error(fields.message ?? "429"), { status: 429, ...fields });
  const now = Date.parse("2026-10-14T12:00:00Z");

  assert.equal(retryAfterMs(limited({ headers: new Headers({ "retry-after": "7" }) }), now), 7000);
  assert.equal(
    retryAfterMs(limited({ headers: new Headers({ "retry-after": "Wed, 14 Oct 2026 12:00:30 GMT" }) }), now),
    30000,
  );
  assert.equal(retryAfterMs(limited({ message: "Please try again in 1m30.5s." })), 90500);
  assert.equal(retryAfterMs(limited({ message: "Please try again in 450ms." })), 450);
  assert.equal(retryAfterMs(limited({ message: "Please try again in 2h13m." })), 7980000);
  assert.equal(retryAfterMs(limited({ message: "Slow down." })), null);

  // Only a 429 means "come back later" - a 503's header is not read.
  const unavailable = Object.assign(new Error("x"), { status: 503, headers: new Headers({ "retry-after": "7" }) });

  assert.equal(retryAfterMs(unavailable), null);
});
