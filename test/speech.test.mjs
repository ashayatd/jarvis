// What Alexa is actually handed: the SSML document, the launch greeting and the
// mic-open reprompt. No server and no executor here - these are the pieces that
// can be called directly, so they are tested directly.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearAllJobs,
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

test("a tag the model invented is stripped, never passed through or read aloud", () => {
  // An allowlist, so an unknown tag can never produce a document Alexa
  // refuses - and it is removed rather than escaped, because escaped it is
  // read out as "less than audio".
  const ssml = toSsml('<audio src="http://evil.test/x.mp3"/> hello');

  assert.equal(ssml, "<speak>hello</speak>");
});

// What every reply is checked for: no tag Alexa would read aloud, and a
// document it will accept.
const spokenTags = (ssml) => ssml.match(/&lt;\/?[a-z][^&]*?&gt;/gi) ?? [];

test("a bare interjection tag becomes the real interjection", () => {
  // What Groq actually sent, from a live turn.
  assert.equal(
    toSsml("<hmm> The landing page folder contains index.html and package.json."),
    '<speak><say-as interpret-as="interjection">hmm</say-as> The landing page folder contains index.html and package.json.</speak>',
  );

  for (const text of ["<Hmm/> right.", "< aha > found it.", "<got it>On it.", "<hmm>ok</hmm>"]) {
    const ssml = toSsml(text);

    assert.match(ssml, /<say-as interpret-as="interjection">(hmm|aha|got it)<\/say-as>/, text);
    assert.deepEqual(spokenTags(ssml), [], text);
  }
});

test("any other non-SSML tag is stripped and its words kept", () => {
  for (const [text, spoken] of [
    ["<b>Done</b>, the server is up.", "Done, the server is up."],
    ["<sigh> That failed.", "That failed."],
    ["<speak>nested</speak>", "nested"],
    ['<voice name="Matthew">hello</voice>', "hello"],
    ["<thinking>", ""],
  ]) {
    assert.equal(toSsml(text), `<speak>${spoken}</speak>`, text);
  }
});

test("a tag left without its partner is removed so the document stays valid", () => {
  // The opener is not on the allowlist and is stripped; the closer is, and on
  // its own would make the document invalid.
  assert.equal(toSsml('<emphasis level="whatever">x</emphasis>'), "<speak>x</speak>");
  assert.equal(toSsml('<say-as interpret-as="interjection">hmm'), "<speak>hmm</speak>");
  assert.equal(toSsml("done</say-as>"), "<speak>done</speak>");
});

test("a break and an emphasis are allowed, with their values pinned", () => {
  assert.match(toSsml('one<break time="500ms"/>two'), /<break time="500ms"\/>/);
  assert.match(
    toSsml('<emphasis level="strong">really</emphasis>'),
    /<emphasis level="strong">really<\/emphasis>/,
  );

  // Not on the allowlist, so it does not survive as a tag.
  assert.ok(!toSsml('<emphasis level="whatever">x</emphasis>').includes("emphasis"));
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
  clearAllJobs();

  const reprompt = repromptFor();

  assert.match(reprompt, /let me know what to do next/i);
  assert.doesNotMatch(reprompt, /seconds in/);
});

test("with a job running the reprompt narrates that job", () => {
  clearAllJobs();

  registerJob({
    sessionKey: busySession,
    label: "ask Claude to build a landing page",
    narration: "Claude is currently building a landing page",
    // Never settles, so the job stays running for the length of the test.
    promise: new Promise(() => {}),
  });

  const reprompt = repromptFor();

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

  const reprompt = repromptFor();

  // One narration and a count: reading every job aloud would be a paragraph.
  assert.match(reprompt, /1 other job running too/);
});

test("a job that has landed stops being narrated", async () => {
  const session = "reprompt-finished";
  clearAllJobs();

  registerJob({
    sessionKey: session,
    label: 'run "git status"',
    narration: "git status is still running",
    promise: Promise.resolve({ ok: true, output: "clean" }),
  });

  // Let the registry record the outcome.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(repromptFor(), /let me know what to do next/i);
  clearAllJobs();
});

test("work from an earlier conversation is still narrated", () => {
  clearAllJobs();

  registerJob({
    sessionKey: "session-a",
    label: "ask Claude to do something",
    narration: "Claude is currently building the thing",
    promise: new Promise(() => {}),
  });

  // Deliberately the opposite of what this asserted before. Starting long work
  // now closes the session, so the conversation that comes back to hear about
  // it always has a different id - scoping the reprompt by session would mean
  // never mentioning the very job the user re-opened the skill for.
  assert.match(repromptFor(), /building the thing/);

  clearAllJobs();
});

// --- the reprompt knows about servers too --------------------------------

const serverSession = "reprompt-server";

test("a running server is woven into the reprompt with its port", () => {
  clearAllJobs();
  registerDaemon({
    sessionKey: serverSession,
    remoteId: "d-one",
    command: "npm run dev",
    url: "http://localhost:5173/",
  });

  const reprompt = repromptFor();

  assert.match(reprompt, /dev server is running on port 5173/);
  assert.match(reprompt, /what's next/i);

  // No job is waiting, so it must not claim anything is going to land.
  assert.doesNotMatch(reprompt, /seconds in/);
  assert.doesNotMatch(reprompt, /tell you when it lands/);

  forgetDaemon("d-one");
});

test("a server that printed no address is still mentioned, without a port", () => {
  registerDaemon({ sessionKey: serverSession, remoteId: "d-quiet", command: "python app.py" });

  const reprompt = repromptFor();

  assert.match(reprompt, /The dev server is running\./);
  // Inventing a port is worse than not naming one.
  assert.doesNotMatch(reprompt, /port/);

  forgetDaemon("d-quiet");
});

test("several servers are counted rather than listed", () => {
  registerDaemon({ sessionKey: serverSession, remoteId: "d-a", command: "npm run dev", url: "http://localhost:5173/" });
  registerDaemon({ sessionKey: serverSession, remoteId: "d-b", command: "npm start", url: "http://localhost:3000/" });

  assert.match(repromptFor(), /2 dev servers are running/);

  forgetDaemon("d-a");
  forgetDaemon("d-b");
});

test("a job and a server are both mentioned, with the job leading", () => {
  clearAllJobs();
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

  const reprompt = repromptFor();

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
  clearAllJobs();
});

test("a server started in an earlier conversation is still mentioned", () => {
  registerDaemon({ sessionKey: "somebody-else", remoteId: "d-theirs", command: "npm run dev" });

  // Same reasoning as jobs: the session that started it is gone by the time
  // anyone hears a reprompt, and staying quiet about a running server would
  // make the reprompt useless in exactly the case it was built for.
  assert.match(repromptFor(), /dev server is running/);

  forgetDaemon("d-theirs");
});

test("with the server released the reprompt goes back to the plain invitation", () => {
  assert.match(repromptFor(), /let me know what to do next/i);
});
