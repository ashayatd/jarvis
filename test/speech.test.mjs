// What Alexa is actually handed: the SSML document, the launch greeting and the
// mic-open reprompt. No server and no executor here - these are the pieces that
// can be called directly, so they are tested directly.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearSessionJobs,
  forgetDaemon,
  registerDaemon,
  registerJob,
} from "../src/data/jobRegistry.js";
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

// --- the reprompt knows about servers too --------------------------------

const serverSession = "reprompt-server";

test("a running server is woven into the reprompt with its port", () => {
  clearSessionJobs(serverSession);
  registerDaemon({
    sessionKey: serverSession,
    remoteId: "d-one",
    command: "npm run dev",
    url: "http://localhost:5173/",
  });

  const reprompt = repromptFor(serverSession);

  assert.match(reprompt, /dev server is running on port 5173/);
  assert.match(reprompt, /what's next/i);

  // No job is waiting, so it must not claim anything is going to land.
  assert.doesNotMatch(reprompt, /seconds in/);
  assert.doesNotMatch(reprompt, /tell you when it lands/);

  forgetDaemon("d-one");
});

test("a server that printed no address is still mentioned, without a port", () => {
  registerDaemon({ sessionKey: serverSession, remoteId: "d-quiet", command: "python app.py" });

  const reprompt = repromptFor(serverSession);

  assert.match(reprompt, /The dev server is running\./);
  // Inventing a port is worse than not naming one.
  assert.doesNotMatch(reprompt, /port/);

  forgetDaemon("d-quiet");
});

test("several servers are counted rather than listed", () => {
  registerDaemon({ sessionKey: serverSession, remoteId: "d-a", command: "npm run dev", url: "http://localhost:5173/" });
  registerDaemon({ sessionKey: serverSession, remoteId: "d-b", command: "npm start", url: "http://localhost:3000/" });

  assert.match(repromptFor(serverSession), /2 dev servers are running/);

  forgetDaemon("d-a");
  forgetDaemon("d-b");
});

test("a job and a server are both mentioned, with the job leading", () => {
  clearSessionJobs(serverSession);
  registerDaemon({
    sessionKey: serverSession,
    remoteId: "d-both",
    command: "npm run dev",
    url: "http://localhost:5173/",
  });
  registerJob({
    sessionKey: serverSession,
    label: "ask Claude to add a hero section",
    narration: "Claude is currently building a hero section",
    promise: new Promise(() => {}),
  });

  const reprompt = repromptFor(serverSession);

  // The job is what the user is waiting on, so it goes first and keeps the
  // closing line; the server is the aside.
  assert.ok(
    reprompt.indexOf("hero section") < reprompt.indexOf("port 5173"),
    `job should lead: ${reprompt}`,
  );
  assert.match(reprompt, /seconds in/);
  assert.match(reprompt, /port 5173/);
  assert.match(reprompt, /tell you when it lands/);

  forgetDaemon("d-both");
  clearSessionJobs(serverSession);
});

test("a server tracked for another session is not mentioned in this one", () => {
  registerDaemon({ sessionKey: "somebody-else", remoteId: "d-theirs", command: "npm run dev" });

  assert.match(repromptFor("reprompt-nobody"), /let me know what to do next/i);

  forgetDaemon("d-theirs");
});

test("with the server released the reprompt goes back to the plain invitation", () => {
  assert.match(repromptFor(serverSession), /let me know what to do next/i);
});
