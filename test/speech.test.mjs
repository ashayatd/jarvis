// What Alexa is actually handed: the SSML document, the launch greeting and the
// mic-open reprompt. No server and no executor here - these are the pieces that
// can be called directly, so they are tested directly.
import assert from "node:assert/strict";
import { test } from "node:test";

import { clearSessionJobs, registerJob } from "../src/data/jobRegistry.js";
import { greetingFor, repromptFor, toSsml } from "../src/routes/alexaRoutes.js";

// --- the SSML document ----------------------------------------------------

test("an interjection survives into the document", () => {
  const ssml = toSsml('<say-as interpret-as="interjection">aha</say-as> found it.');

  assert.equal(ssml, '<speak><say-as interpret-as="interjection">aha</say-as> found it.</speak>');
});

test("an ampersand in tool output cannot break the document", () => {
  // The reason any of this escaping exists. One stray & makes the document
  // invalid, and Alexa then says "there was a problem with the requested
  // skill's response" instead of speaking at all - and git output, file
  // contents and error text all pass through here.
  const ssml = toSsml("I ran build && test and it passed.");

  assert.ok(!/&(?!amp;|lt;|gt;)/.test(ssml), `unescaped ampersand in ${ssml}`);
  assert.match(ssml, /build &amp;&amp; test/);
});

test("angle brackets that are not an allowed tag are escaped", () => {
  const ssml = toSsml("the type is Array<string> and 3 < 4");

  assert.match(ssml, /Array&lt;string&gt;/);
  assert.match(ssml, /3 &lt; 4/);
});

test("a tag the model invented is escaped rather than passed through", () => {
  // An allowlist, so an unknown tag is spoken as words at worst - it can never
  // produce a document Alexa refuses.
  const ssml = toSsml('<audio src="http://evil.test/x.mp3"/> hello');

  assert.match(ssml, /&lt;audio/);
  assert.ok(!ssml.includes("<audio"));
});

test("a break and an emphasis are allowed, with their values pinned", () => {
  assert.match(toSsml('one<break time="500ms"/>two'), /<break time="500ms"\/>/);
  assert.match(
    toSsml('<emphasis level="strong">really</emphasis>'),
    /<emphasis level="strong">really<\/emphasis>/,
  );

  // Not on the allowlist, so escaped.
  assert.match(toSsml('<emphasis level="whatever">x</emphasis>'), /&lt;emphasis/);
});

test("the document is always wrapped in speak", () => {
  for (const text of ["", "plain words", "&", "<b>bold</b>"]) {
    const ssml = toSsml(text);

    assert.ok(ssml.startsWith("<speak>"), ssml);
    assert.ok(ssml.endsWith("</speak>"), ssml);
  }
});

// --- the launch greeting --------------------------------------------------

test("the greeting follows the clock", () => {
  assert.match(greetingFor(5), /Good morning/);
  assert.match(greetingFor(9), /Good morning/);
  assert.match(greetingFor(12), /Good afternoon/);
  assert.match(greetingFor(16), /Good afternoon/);
  assert.match(greetingFor(17), /Good evening/);
  assert.match(greetingFor(21), /Good evening/);

  // The small hours get their own line rather than being called evening.
  assert.match(greetingFor(23), /Working late/);
  assert.match(greetingFor(3), /Working late/);
});

test("every hour of the day produces a greeting that names Pluto", () => {
  for (let hour = 0; hour < 24; hour++) {
    assert.match(greetingFor(hour), /Pluto is here/, `hour ${hour}`);
  }
});

// --- the reprompt ---------------------------------------------------------

const idleSession = "reprompt-idle";
const busySession = "reprompt-busy";

test("with nothing running the reprompt is a plain invitation", () => {
  clearSessionJobs(idleSession);

  const reprompt = repromptFor(idleSession);

  assert.match(reprompt, /let me know what to do next/i);
  assert.doesNotMatch(reprompt, /seconds in/);
});

test("with a job running the reprompt narrates that job", () => {
  clearSessionJobs(busySession);

  registerJob({
    sessionKey: busySession,
    label: "ask Claude to build a landing page",
    narration: "Claude is currently building a landing page",
    // Never settles, so the job stays running for the length of the test.
    promise: new Promise(() => {}),
  });

  const reprompt = repromptFor(busySession);

  assert.match(reprompt, /Claude is currently building a landing page/);
  assert.match(reprompt, /seconds in/);
  assert.match(reprompt, /tell you when it lands/i);
});

test("a second job is counted rather than read out as well", () => {
  registerJob({
    sessionKey: busySession,
    label: 'run "npm start"',
    narration: "npm start is still running",
    promise: new Promise(() => {}),
  });

  const reprompt = repromptFor(busySession);

  // One narration and a count: reading every job aloud would be a paragraph.
  assert.match(reprompt, /1 other job running too/);
});

test("a job that has landed stops being narrated", async () => {
  const session = "reprompt-finished";
  clearSessionJobs(session);

  registerJob({
    sessionKey: session,
    label: 'run "git status"',
    narration: "git status is still running",
    promise: Promise.resolve({ ok: true, output: "clean" }),
  });

  // Let the registry record the outcome.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(repromptFor(session), /let me know what to do next/i);
  clearSessionJobs(session);
});

test("one session's work is never narrated into another", () => {
  clearSessionJobs("session-a");
  clearSessionJobs("session-b");

  registerJob({
    sessionKey: "session-a",
    label: "ask Claude to do something",
    narration: "Claude is currently building the thing",
    promise: new Promise(() => {}),
  });

  assert.match(repromptFor("session-a"), /building the thing/);
  assert.match(repromptFor("session-b"), /let me know what to do next/i);

  clearSessionJobs("session-a");
  clearSessionJobs(busySession);
});
