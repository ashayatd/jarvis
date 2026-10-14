import express from "express";
import {
  addAssistantMessage,
  addSystemNote,
  addToolResult,
  addUserMessage,
  createChatMemory,
  resetChatHistory,
  trimHistory,
} from "../data/chatMemory.js";
import {
  describeJob,
  getAllDaemons,
  getRunningJobs,
  jobCount,
  registerJob,
  takeUnreportedJobs,
} from "../data/jobRegistry.js";
import { BACKGROUND_TIMEOUT_MS } from "../services/executorService.js";
import { generateAIReply } from "../services/llmService.js";
import {
  describeToolCall,
  isBackgroundable,
  narrateToolCall,
  parseToolArgs,
  runTool,
  toolSchemas,
} from "../tools/registry.js";
import { log, logError, logTurn, logWarn, startTimer } from "../utils/logger.js";

const router = express.Router();

// One memory per Alexa session. Entries are swept on a TTL because every
// session gets a fresh id and this process stays up for weeks.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

// Each round is one LLM call plus one hop to the PC, inside Alexa's ~8s
// budget. Two is what fits.
const MAX_TOOL_ROUNDS = 2;

// How long a tool may block the spoken reply before it is handed to the job
// registry. Alexa gives ~8s total and the first LLM call has already spent
// some of it, so this stays well under half the budget.
const TOOL_DEADLINE_MS = Number(process.env.TOOL_DEADLINE_MS || 3500);

const DEADLINE = Symbol("deadline");

// The same idea one level up, around the whole turn. The tool deadline can only
// see one tool at a time, so it cannot catch a turn that is slow by
// accumulation: three model calls and two tools, each fine on its own, together
// past what Alexa will wait for. When that happens Alexa gives up on the skill
// and the user hears an error instead of an answer.
//
// Above TOOL_DEADLINE_MS on purpose. A single slow tool should be handed off by
// the inner race, which returns in about three and a half seconds, so reaching
// this one means the turn as a whole ran long rather than one step of it.
const TURN_DEADLINE_MS = Number(process.env.TURN_DEADLINE_MS || 4000);

// A symbol rather than the string it stands for, so it cannot be confused with
// anything a turn might legitimately resolve to.
const SHIFT_TO_BACKGROUND = Symbol("shift-to-background");

const HEAVY_TASK_REPLY =
  "This is a heavy task, I am shifting it to the background. Ask for a status update in a minute.";

// Spoken only if the user goes quiet with the mic still open, and only when
// there is nothing running to talk about instead.
const IDLE_REPROMPT = "I'm still here, let me know what to do next.";

// Server local time, not the echo's. Alexa only reports the device timezone
// through the Settings API, which is another round trip inside an 8 second
// budget - fine while the PC and the speaker are in the same house, wrong for
// anyone running this remotely.
// Exported for the tests: the clock cannot be moved from outside, so the only
// way to assert every branch is to call this with the hour directly.
export const greetingFor = (hour) => {
  if (hour >= 5 && hour < 12) return "Good morning! Pluto is here!!";
  if (hour >= 12 && hour < 17) return "Good afternoon! Pluto is here!!";
  if (hour >= 17 && hour < 22) return "Good evening! Pluto is here!!";

  return "Working late! Pluto is here!!";
};

// The port a server reported, for the reprompt to name. Best effort: a server
// that printed nothing leaves this null and the phrasing drops the port rather
// than inventing one.
const portOf = (url) => {
  try {
    return new URL(url).port || null;
  } catch {
    return null;
  }
};

const describeServers = (servers) => {
  if (servers.length > 1) {
    return `${servers.length} dev servers are running.`;
  }

  const port = servers[0].url ? portOf(servers[0].url) : null;

  return port ? `The dev server is running on port ${port}.` : "The dev server is running.";
};

// What the mic-open reprompt should say right now, from both things that can be
// in flight: work being waited on, and servers that are simply up. Either is
// more useful than a stock line - a reprompt is the only place the user hears
// about them without having to ask.
//
// Not scoped to the session. A long job now ends the session as it starts, so
// by the time anyone hears a reprompt again it is a different conversation with
// a different id - scoping this would have meant never mentioning the very work
// the user re-opened the skill to ask about.
export const repromptFor = () => {
  const running = getRunningJobs();
  const servers = getAllDaemons();

  if (!running.length) {
    return servers.length
      ? `${describeServers(servers)} Let me know what's next.`
      : IDLE_REPROMPT;
  }

  const [first] = running;
  const elapsed = Math.round((Date.now() - first.startedAt) / 1000);
  const what = first.narration || first.label || "something";
  const others =
    running.length > 1 ? ` I have ${running.length - 1} other job running too.` : "";

  // A server alongside the work is worth one clause, not a second sentence
  // competing with it - the job is the thing the user is waiting on.
  const alongside = servers.length ? ` ${describeServers(servers)}` : "";

  return `${what}, about ${elapsed} seconds in.${others}${alongside} I'll tell you when it lands.`;
};

// Matched exactly, not by substring, so "thanks for that, now open vs code"
// stays a normal turn.
const FAREWELLS = new Set([
  "thank you",
  "thanks",
  "thanks a lot",
  "thank you very much",
]);

// Also exact, for the same reason: substring matching killed the session on
// ordinary commands like "close vs code" or "stop the build".
const EXIT_PHRASES = new Set([
  "exit",
  "stop",
  "goodbye",
  "exit ai mode",
  "exit pluto",
  "quit",
]);

// Alexa's built-in intents arrive with no slots and no transcript, so they can
// never produce a query. They have to be handled by name before extraction, or
// every one of them falls through to the "I didn't catch that" branch - which
// is why saying "stop" or "cancel" was answered with an instruction to say
// "tell me" instead of ending the session.
const BUILTIN_ENDINGS = new Set(["AMAZON.StopIntent", "AMAZON.CancelIntent"]);

const HELP_TEXT =
  "Ask me anything, or say open VS Code to work on a project. I can also run git commands and hand coding jobs to Claude. What would you like?";

// An interaction model with a bare {query} sample puts the whole utterance in
// the slot, carrier phrase and all, so "tell me stop" arrives where "stop"
// used to. Stripped only for the exact-match lists below - the model still
// receives what the user actually said.
const CARRIER_PHRASES = /^(?:pluto|ai mode|jarvis|alexa|computer|tell me|ask|say)\s+/;

// Punctuation and case removed so "Thank you!" matches. Used for every exact
// match list.
const normalizePhrase = (text) => {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/ +/g, " ")
    .trim();

  return cleaned.replace(CARRIER_PHRASES, "").trim() || cleaned;
};

const sessionKeyFor = (req) =>
  req.body.session?.sessionId ||
  req.body.session?.user?.userId ||
  req.body.context?.System?.user?.userId ||
  "default";

const sweepSessions = () => {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of sessions) {
    if (now - entry.lastSeen > SESSION_TTL_MS) {
      sessions.delete(key);
      removed += 1;
    }
  }

  if (removed) {
    log(`[SESS] swept ${removed} idle session(s), ${sessions.size} active`);
  }
};

// Returns the whole entry, not just the memory: the run of missed utterances is
// counted per session, so it has to live somewhere that spans turns.
const getSession = (req) => {
  sweepSessions();

  const key = sessionKeyFor(req);
  let entry = sessions.get(key);

  if (!entry) {
    entry = { memory: createChatMemory(), lastSeen: Date.now(), fallbackStreak: 0 };
    sessions.set(key, entry);
    log(`[SESS] new session=${key} (${sessions.size} active)`);
  } else {
    log(`[SESS] resumed session=${key} history=${entry.memory.messages.length} msgs`);
  }

  entry.lastSeen = Date.now();

  return entry;
};

// Alexa speaks this string literally, so markdown has to go even though the
// system prompt forbids it - models emit it anyway.
const forSpeech = (text) => {
  const cleaned = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#]+/g, "")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "Sorry, I didn't get that.";
};

// The interjections are SSML, and SSML in a PlainText response is read out as
// words - "say as interpret as interjection hmm". So responses are SSML now,
// which brings a problem PlainText did not have: one stray "&" anywhere makes
// the document invalid and Alexa answers "there was a problem with the
// requested skill's response" instead of speaking at all. Tool output goes
// through here - git output, file contents - so that is a real risk, not a
// theoretical one.
//
// Everything is escaped first and then the handful of tags worth allowing are
// put back. An allowlist, so a tag the model invents cannot break the document.
const SSML_TAGS = [
  [/&lt;say-as interpret-as="interjection"&gt;/g, '<say-as interpret-as="interjection">'],
  [/&lt;\/say-as&gt;/g, "</say-as>"],
  [/&lt;break time="(\d{1,4}m?s)"\s*\/?&gt;/g, '<break time="$1"/>'],
  [/&lt;emphasis level="(strong|moderate|reduced)"&gt;/g, '<emphasis level="$1">'],
  [/&lt;\/emphasis&gt;/g, "</emphasis>"],
];

// Models write the interjection as a bare tag - "<hmm> The folder contains" -
// instead of the SSML form the prompt shows. Escaped, that is read out as
// "less than hmm greater than". A bare tag naming one of these becomes the real
// thing; any other bare tag is stripped below.
const INTERJECTION_WORDS = new Set([
  "hmm",
  "aha",
  "got it",
  "wow",
  "phew",
  "whoops",
  "yay",
  "uh oh",
  "oh boy",
  "oh dear",
]);

const BARE_TAG = /<\s*(\/?)\s*([a-z][a-z' ]*?)\s*\/?\s*>/gi;

const convertBareInterjections = (text) =>
  text.replace(BARE_TAG, (whole, closing, name) => {
    const word = name.trim().toLowerCase();

    if (!INTERJECTION_WORDS.has(word)) return whole;

    return closing ? "" : `<say-as interpret-as="interjection">${word}</say-as>`;
  });

// Whatever is still tag-shaped after the allowlist is markup the model
// invented, and Alexa would read it aloud - so it goes, and its text stays.
// An opening tag glued to the word before it ("Array<string>") is code being
// talked about rather than markup, and is left to be read as words.
const STRAY_OPEN_TAG =
  /(^|[^A-Za-z0-9])&lt;[a-z][\w-]*(?:\s+[\w-]+(?:=(?:"[^"]*"|'[^']*'))?)*\s*\/?&gt;/gi;
const STRAY_CLOSE_TAG = /&lt;\/[a-z][\w-]*\s*&gt;/gi;

// An allowed opener whose closer was stripped, or the reverse, makes the
// document invalid - and Alexa then speaks an error instead of anything. A
// tag that does not balance is removed entirely; its words are kept.
const PAIRED_TAGS = [
  [/<say-as interpret-as="interjection">/g, /<\/say-as>/g],
  [/<emphasis level="(?:strong|moderate|reduced)">/g, /<\/emphasis>/g],
];

const dropUnbalanced = (ssml) =>
  PAIRED_TAGS.reduce((text, [open, close]) => {
    const opens = text.match(open)?.length ?? 0;
    const closes = text.match(close)?.length ?? 0;

    return opens === closes ? text : text.replace(open, "").replace(close, "");
  }, ssml);

export const toSsml = (text) => {
  let escaped = convertBareInterjections(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  for (const [pattern, tag] of SSML_TAGS) {
    escaped = escaped.replace(pattern, tag);
  }

  const cleaned = dropUnbalanced(
    escaped.replace(STRAY_OPEN_TAG, "$1").replace(STRAY_CLOSE_TAG, ""),
  )
    .replace(/\s{2,}/g, " ")
    .trim();

  return `<speak>${cleaned}</speak>`;
};

const speech = (text) => ({ type: "SSML", ssml: toSsml(text) });

const buildAlexaResponse = (text, shouldEndSession = false, sessionKey = null) => {
  const spoken = forSpeech(text);

  log(`[SAY ] "${spoken}"${shouldEndSession ? " [END SESSION]" : " [MIC OPEN]"}`);

  const response = {
    outputSpeech: speech(spoken),
    shouldEndSession,
  };

  // Without a reprompt Alexa closes the mic after speaking, forcing the skill
  // to be re-invoked every turn. It is spoken only if the user stays silent.
  // Pointless once the session is ending, so it is left off there.
  //
  // Built here rather than passed in, so every mic-open reply narrates whatever
  // is running without each call site having to remember to ask.
  if (!shouldEndSession) {
    const reprompt = sessionKey ? repromptFor(sessionKey) : IDLE_REPROMPT;

    log(`[RPT ] "${reprompt}"`);

    response.reprompt = { outputSpeech: speech(forSpeech(reprompt)) };
  }

  return {
    version: "1.0",
    response,
  };
};

const extractUserQuery = (req) => {
  const slots = req.body.request?.intent?.slots || {};

  // The first slot with a value, not simply the first slot: an intent with
  // more than one slot leaves the unused ones present but empty, and picking
  // blindly threw the utterance away whenever an empty one came back first.
  const spoken = Object.values(slots).find((slot) => slot?.value)?.value;

  return spoken || req.body.request?.inputTranscript;
};

// Races the tool against the deadline. If the deadline wins, the SAME promise
// keeps running and is handed to the job registry - nothing is cancelled or
// restarted, so the work is never done twice.
const runToolOrBackground = async (toolCall, sessionKey) => {
  const name = toolCall.function?.name;
  const args = parseToolArgs(toolCall) ?? {};

  // Reading job state must stay instant, or "is it done?" would itself queue.
  if (!isBackgroundable(name)) {
    return { mode: "inline", result: await runTool(toolCall, { sessionKey }) };
  }

  // Started with the long timeout up front: if this becomes a job it must
  // outlive the deadline, and an abort signal cannot be extended later.
  const startedAt = Date.now();
  const promise = runTool(toolCall, {
    sessionKey,
    timeoutMs: BACKGROUND_TIMEOUT_MS,
  });

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), TOOL_DEADLINE_MS);
  });

  const winner = await Promise.race([promise, deadline]);
  clearTimeout(timer);

  if (winner !== DEADLINE) {
    return { mode: "inline", result: winner };
  }

  logWarn(`[BG  ] ${name} exceeded ${TOOL_DEADLINE_MS}ms - handing off to job registry`);

  const job = registerJob({
    sessionKey,
    label: describeToolCall(name, args),
    narration: narrateToolCall(name, args),
    promise,
    startedAt,
  });

  return { mode: "background", job };
};

// "groq 812ms + ollama 2410ms" - which model answered each call of a turn and
// how long it took, for the turn's closing log line.
const describeLlmCalls = (calls) =>
  calls.length ? calls.map(({ provider, latencyMs }) => `${provider} ${latencyMs}ms`).join(" + ") : "none";

// Runs the model, executes any tools it asks for, feeds results back, and
// repeats until it produces something to say. Every model call is recorded in
// `llmCalls`, which the caller owns so it can still read it after a turn has
// been shifted to the background.
const runConversationTurn = async (chatMemory, sessionKey, llmCalls = []) => {
  const ask = async () => {
    const reply = await generateAIReply(chatMemory, { tools: toolSchemas });

    if (reply.provider) {
      llmCalls.push({ provider: reply.provider, latencyMs: reply.latencyMs });
    }

    return reply;
  };

  let message = await ask();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (!message.tool_calls?.length) {
      break;
    }

    log(`[LOOP] round ${round + 1}/${MAX_TOOL_ROUNDS}, ${message.tool_calls.length} tool call(s)`);

    // The assistant turn carrying tool_calls must be stored before its
    // results, or the tool messages have no parent to attach to.
    addAssistantMessage(chatMemory, message);

    let backgrounded = false;

    for (const toolCall of message.tool_calls) {
      const outcome = await runToolOrBackground(toolCall, sessionKey);

      if (outcome.mode === "background") {
        backgrounded = true;

        addToolResult(chatMemory, toolCall.id, {
          ok: true,
          status: "running",
          job_id: outcome.job.id,
          note: "Still running in the background. The user can ask for a status update.",
        });
      } else {
        addToolResult(chatMemory, toolCall.id, outcome.result);
      }
    }

    // Something went to the background. Answering now costs one fewer LLM
    // call, which matters because the deadline already spent most of the
    // budget - so this reply is canned rather than generated.
    //
    // And the session closes with it. There is nothing to say for the minutes
    // this will take, so holding the mic open only leaves the light ring on
    // until Alexa times out on its own. The reply has to carry the way back in,
    // because closing means the user re-opens the skill to ask.
    if (backgrounded) {
      log("[LOOP] backgrounded work - replying early and closing the session");

      return {
        role: "assistant",
        content:
          "On it. That's running in the background. Open Pluto again and ask for a status update whenever you like.",
        endSession: true,
      };
    }

    message = await ask();
  }

  // Ran out of rounds while still asking for tools - say something rather
  // than handing Alexa a null-content message.
  if (message.tool_calls?.length) {
    logWarn(`[LOOP] still requesting tools after ${MAX_TOOL_ROUNDS} rounds - stopping`);
    addAssistantMessage(chatMemory, message);

    return {
      role: "assistant",
      content: "That needed more steps than I can do in one go. Could you break it down for me?",
    };
  }

  return message;
};

// Finished work the user was never told about, injected so Pluto can mention
// it unprompted instead of waiting to be asked. Read across sessions, because
// the conversation that started the work is usually not the one that comes back
// to hear how it went.
const injectFinishedJobs = (chatMemory, sessionKey) => {
  const finished = takeUnreportedJobs();

  if (!finished.length) {
    return;
  }

  const summary = JSON.stringify(finished.map(describeJob));

  log(`[BG  ] injecting ${finished.length} finished job(s) into session=${sessionKey}`);

  addSystemNote(
    chatMemory,
    `A background task you started earlier has finished: ${summary}. Mention this naturally to the user before answering.`,
  );
};

router.post("/alexa", async (req, res) => {
  const turnTimer = startTimer();
  const sessionKey = sessionKeyFor(req);

  try {
    const requestType = req.body.request?.type;

    // The conversation is forgotten; the work is not. A session ending is not a
    // reason to lose a job that is still running, and it used to be: the result
    // the user came back for was thrown away the moment the light ring went out.
    if (requestType === "SessionEndedRequest") {
      log(`[TURN] SessionEndedRequest session=${sessionKey} (${jobCount()} job(s) kept)`);
      sessions.delete(sessionKey);

      return res.json(buildAlexaResponse("Goodbye!", true));
    }

    if (requestType === "LaunchRequest") {
      const greeting = greetingFor(new Date().getHours());

      log(`[TURN] LaunchRequest session=${sessionKey} greeting="${greeting}"`);

      return res.json(
        buildAlexaResponse(`${greeting} How can I assist you?`, false, sessionKey),
      );
    }

    const intentName = req.body.request?.intent?.name;

    // "stop" and "cancel" are routed to built-ins by Alexa before any custom
    // intent sees them, so this is the only place they can be caught.
    if (BUILTIN_ENDINGS.has(intentName)) {
      log(`[TURN] ${intentName} - closing session=${sessionKey} (${jobCount()} job(s) kept)`);
      sessions.delete(sessionKey);

      return res.json(buildAlexaResponse("Goodbye!", true));
    }

    if (intentName === "AMAZON.HelpIntent") {
      log(`[TURN] AMAZON.HelpIntent session=${sessionKey}`);

      return res.json(buildAlexaResponse(HELP_TEXT, false, sessionKey));
    }

    const userQuery = extractUserQuery(req);

    // A fallback carries no transcript at all - the words are gone and cannot
    // be recovered here, so the only fix is in the interaction model. What can
    // be done is to stop repeating one useless line: asking again is right
    // once, but if it keeps happening the model is not matching and the user
    // needs the one phrasing that always does. See alexa/README.md.
    if (!userQuery) {
      const session = getSession(req);
      session.fallbackStreak = (session.fallbackStreak ?? 0) + 1;

      logWarn(
        `[TURN] no query extracted session=${sessionKey}`,
        `intent=${intentName ?? requestType}`,
        `streak=${session.fallbackStreak}`,
      );

      return res.json(
        buildAlexaResponse(
          session.fallbackStreak === 1
            ? "Sorry, I missed that. Could you say it again?"
            : "I missed that. Try saying Pluto, followed by your command.",
          false,
          sessionKey,
        ),
      );
    }

    logTurn(sessionKey, userQuery, intentName);

    const normalized = normalizePhrase(userQuery);

    if (FAREWELLS.has(normalized)) {
      log(`[TURN] farewell - closing session=${sessionKey} (${jobCount()} job(s) kept)`);
      sessions.delete(sessionKey);

      return res.json(buildAlexaResponse("You're welcome, goodbye!", true));
    }

    if (EXIT_PHRASES.has(normalized)) {
      log(`[TURN] exit phrase - closing session=${sessionKey} (${jobCount()} job(s) kept)`);
      sessions.delete(sessionKey);

      return res.json(buildAlexaResponse("Exiting AI mode. Goodbye!", true));
    }

    const session = getSession(req);
    const chatMemory = session.memory;

    // Something was understood, so the run of failures is over.
    session.fallbackStreak = 0;

    const lower = userQuery.toLowerCase();

    if (
      lower.includes("new topic") ||
      lower.includes("don't want to continue") ||
      lower.includes("forget that") ||
      lower.includes("something else") ||
      lower.includes("change topic") ||
      lower.includes("another topic")
    ) {
      log(`[TURN] topic reset keyword - clearing history for session=${sessionKey}`);
      resetChatHistory(chatMemory);
    }

    addUserMessage(chatMemory, userQuery);
    injectFinishedJobs(chatMemory, sessionKey);

    const startedAt = Date.now();
    const llmCalls = [];
    const turn = runConversationTurn(chatMemory, sessionKey, llmCalls);

    let timer;
    const shift = new Promise((resolve) => {
      timer = setTimeout(() => resolve(SHIFT_TO_BACKGROUND), TURN_DEADLINE_MS);
    });

    // The turn keeps running whichever way this lands. Nothing is cancelled:
    // the work is already in flight on the PC, and abandoning it would be worse
    // than finishing it with nobody waiting.
    const winner = await Promise.race([turn, shift]);
    clearTimeout(timer);

    if (winner === SHIFT_TO_BACKGROUND) {
      const asked = userQuery.length > 60 ? `${userQuery.slice(0, 60)}...` : userQuery;

      logWarn(
        `[TURN] over ${TURN_DEADLINE_MS}ms session=${sessionKey}`,
        "- shifting the rest to the background",
      );

      // Detached before handing off, and this is the whole reason it has to be.
      // The abandoned turn is still inside its loop and will go on appending
      // assistant and tool messages as it finishes. If the next turn shared
      // this history, those writes would interleave with it and strand a tool
      // message away from the assistant turn that called it, which the API
      // rejects - so one slow turn would poison every turn after it. Giving the
      // session a fresh memory leaves the old one to the work that is still
      // using it, and costs nothing here: the session is closing anyway.
      session.memory = createChatMemory();

      registerJob({
        sessionKey,
        label: `the answer to "${asked}"`,
        narration: `I'm still working on "${asked}"`,
        // Mapped to a small result, because this is what the model reads back
        // later - the whole message object would carry tool_calls and noise.
        promise: turn.then((finished) => {
          log(`[TURN] background turn finished session=${sessionKey} llm=${describeLlmCalls(llmCalls)}`);

          return { ok: true, asked, reply: finished.content };
        }),
        startedAt,
      });

      return res.json(buildAlexaResponse(HEAVY_TASK_REPLY, true, sessionKey));
    }

    const message = winner;

    addAssistantMessage(chatMemory, message);
    trimHistory(chatMemory);

    log(
      `[TURN] complete in ${turnTimer()}ms`,
      `llm=${describeLlmCalls(llmCalls)}`,
      `history=${chatMemory.messages.length} msgs`,
      `jobs=${jobCount()}`,
      message.endSession ? "[closing for background work]" : "",
    );

    // The chat memory stays. Nothing is reading it once the session closes, but
    // the TTL sweep will take it, and keeping it costs nothing meanwhile.
    return res.json(
      buildAlexaResponse(message.content, message.endSession === true, sessionKey),
    );
  } catch (error) {
    logError(`[TURN] failed after ${turnTimer()}ms session=${sessionKey}`);
    logError(error?.stack || error);

    return res.json(buildAlexaResponse("Something went wrong", false, sessionKey));
  }
});

export default router;
