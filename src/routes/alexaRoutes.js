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
  clearSessionJobs,
  describeJob,
  jobCount,
  registerJob,
  takeUnreportedJobs,
} from "../data/jobRegistry.js";
import { BACKGROUND_TIMEOUT_MS } from "../services/executorService.js";
import { generateAIReply } from "../services/groqService.js";
import {
  describeToolCall,
  isBackgroundable,
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

// Spoken only if the user goes quiet with the mic still open.
const REPROMPT_TEXT = "I'm listening.";

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
  "quit",
]);

// Punctuation and case removed so "Thank you!" matches. Used for both exact
// match lists.
const normalizePhrase = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/ +/g, " ")
    .trim();

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

const getSessionMemory = (req) => {
  sweepSessions();

  const key = sessionKeyFor(req);
  let entry = sessions.get(key);

  if (!entry) {
    entry = { memory: createChatMemory(), lastSeen: Date.now() };
    sessions.set(key, entry);
    log(`[SESS] new session=${key} (${sessions.size} active)`);
  } else {
    log(`[SESS] resumed session=${key} history=${entry.memory.messages.length} msgs`);
  }

  entry.lastSeen = Date.now();

  return entry.memory;
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

const buildAlexaResponse = (text, shouldEndSession = false) => {
  const spoken = forSpeech(text);

  log(`[SAY ] "${spoken}"${shouldEndSession ? " [END SESSION]" : " [MIC OPEN]"}`);

  const response = {
    outputSpeech: {
      type: "PlainText",
      text: spoken,
    },
    shouldEndSession,
  };

  // Without a reprompt Alexa closes the mic after speaking, forcing the skill
  // to be re-invoked every turn. It is spoken only if the user stays silent.
  // Pointless once the session is ending, so it is left off there.
  if (!shouldEndSession) {
    response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: REPROMPT_TEXT,
      },
    };
  }

  return {
    version: "1.0",
    response,
  };
};

const extractUserQuery = (req) => {
  const slots = req.body.request?.intent?.slots || {};
  let userQuery = Object.values(slots)[0]?.value;

  if (!userQuery) {
    userQuery = req.body.request?.inputTranscript;
  }

  return userQuery;
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
  const promise = runTool(toolCall, { sessionKey, timeoutMs: BACKGROUND_TIMEOUT_MS });

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
    promise,
    startedAt,
  });

  return { mode: "background", job };
};

// Runs the model, executes any tools it asks for, feeds results back, and
// repeats until it produces something to say.
const runConversationTurn = async (chatMemory, sessionKey) => {
  let message = await generateAIReply(chatMemory, { tools: toolSchemas });

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
    if (backgrounded) {
      log("[LOOP] backgrounded work - replying early without another LLM call");

      return {
        role: "assistant",
        content: "I've started that. Ask me for a status update in a bit.",
      };
    }

    message = await generateAIReply(chatMemory, { tools: toolSchemas });
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

// Finished work the user was never told about, injected so Jarvis can mention
// it unprompted instead of waiting to be asked.
const injectFinishedJobs = (chatMemory, sessionKey) => {
  const finished = takeUnreportedJobs(sessionKey);

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

    if (requestType === "SessionEndedRequest") {
      log(`[TURN] SessionEndedRequest session=${sessionKey}`);
      sessions.delete(sessionKey);
      clearSessionJobs(sessionKey);

      return res.json(buildAlexaResponse("Goodbye!", true));
    }

    if (requestType === "LaunchRequest") {
      log(`[TURN] LaunchRequest session=${sessionKey}`);

      return res.json(
        buildAlexaResponse("AI mode activated. How can I assist you?", false),
      );
    }

    const userQuery = extractUserQuery(req);

    if (!userQuery) {
      logWarn(`[TURN] no query extracted session=${sessionKey} type=${requestType}`);

      return res.json(
        buildAlexaResponse(
          "I didn't catch that properly. Please say tell me followed by your question.",
          false,
        ),
      );
    }

    logTurn(sessionKey, userQuery);

    const normalized = normalizePhrase(userQuery);

    if (FAREWELLS.has(normalized)) {
      log(`[TURN] farewell - closing session=${sessionKey}`);
      sessions.delete(sessionKey);
      clearSessionJobs(sessionKey);

      return res.json(buildAlexaResponse("You're welcome, goodbye!", true));
    }

    if (EXIT_PHRASES.has(normalized)) {
      log(`[TURN] exit phrase - clearing session=${sessionKey}`);
      sessions.delete(sessionKey);
      clearSessionJobs(sessionKey);

      return res.json(buildAlexaResponse("Exiting AI mode. Goodbye!", true));
    }

    const chatMemory = getSessionMemory(req);
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

    const message = await runConversationTurn(chatMemory, sessionKey);

    addAssistantMessage(chatMemory, message);
    trimHistory(chatMemory, 20);

    log(
      `[TURN] complete in ${turnTimer()}ms`,
      `history=${chatMemory.messages.length} msgs`,
      `jobs=${jobCount()}`,
    );

    return res.json(buildAlexaResponse(message.content, false));
  } catch (error) {
    logError(`[TURN] failed after ${turnTimer()}ms session=${sessionKey}`);
    logError(error?.stack || error);

    return res.json(buildAlexaResponse("Something went wrong", false));
  }
});

export default router;
