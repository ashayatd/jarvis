import express from "express";
import {
  addAssistantMessage,
  addToolResult,
  addUserMessage,
  createChatMemory,
  resetChatHistory,
  trimHistory,
} from "../data/chatMemory.js";
import { generateAIReply } from "../services/groqService.js";
import { runTool, toolSchemas } from "../tools/registry.js";
import { log, logError } from "../utils/logger.js";

const router = express.Router();

// One memory per Alexa session. Entries are swept on a TTL because every
// session gets a fresh id and this process stays up for weeks.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

// Each round is one LLM call plus one hop to the PC, inside Alexa's ~8s
// budget. Two is what fits.
const MAX_TOOL_ROUNDS = 2;

const sessionKeyFor = (req) =>
  req.body.session?.sessionId ||
  req.body.session?.user?.userId ||
  req.body.context?.System?.user?.userId ||
  "default";

const sweepSessions = () => {
  const now = Date.now();

  for (const [key, entry] of sessions) {
    if (now - entry.lastSeen > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
};

const getSessionMemory = (req) => {
  sweepSessions();

  const key = sessionKeyFor(req);
  let entry = sessions.get(key);

  if (!entry) {
    entry = { memory: createChatMemory(), lastSeen: Date.now() };
    sessions.set(key, entry);
    log(`new session ${key} (${sessions.size} active)`);
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

const buildAlexaResponse = (text, shouldEndSession = false) => ({
  version: "1.0",
  response: {
    outputSpeech: {
      type: "PlainText",
      text: forSpeech(text),
    },
    shouldEndSession,
  },
});

const extractUserQuery = (req) => {
  const slots = req.body.request?.intent?.slots || {};
  let userQuery = Object.values(slots)[0]?.value;

  if (!userQuery) {
    userQuery = req.body.request?.inputTranscript;
  }

  return userQuery;
};

// Runs the model, executes any tools it asks for, feeds the results back, and
// repeats until it produces something to say.
const runConversationTurn = async (chatMemory) => {
  let message = await generateAIReply(chatMemory, { tools: toolSchemas });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (!message.tool_calls?.length) {
      break;
    }

    // The assistant turn carrying tool_calls must be stored before its
    // results, or the tool messages have no parent to attach to.
    addAssistantMessage(chatMemory, message);

    for (const toolCall of message.tool_calls) {
      const result = await runTool(toolCall);

      log(`tool ${toolCall.function?.name} ->`, JSON.stringify(result).slice(0, 200));
      addToolResult(chatMemory, toolCall.id, result);
    }

    message = await generateAIReply(chatMemory, { tools: toolSchemas });
  }

  // Ran out of rounds while still asking for tools - say something rather
  // than handing Alexa a null-content message.
  if (message.tool_calls?.length) {
    addAssistantMessage(chatMemory, message);

    return {
      role: "assistant",
      content: "That needed more steps than I can do in one go. Could you break it down for me?",
    };
  }

  return message;
};

router.post("/alexa", async (req, res) => {
  try {
    log("/alexa endpoint hit");

    const requestType = req.body.request?.type;

    if (requestType === "SessionEndedRequest") {
      sessions.delete(sessionKeyFor(req));

      return res.json(buildAlexaResponse("Goodbye!", true));
    }

    if (requestType === "LaunchRequest") {
      return res.json(
        buildAlexaResponse("AI mode activated. How can I assist you?", false),
      );
    }

    const chatMemory = getSessionMemory(req);

    let userQuery = extractUserQuery(req);

    if (!userQuery) {
      return res.json(
        buildAlexaResponse(
          "I didn't catch that properly. Please say tell me followed by your question.",
          false,
        ),
      );
    }

    log("User Query:", userQuery);

    const lower = userQuery.toLowerCase();

    if (
      lower.includes("exit") ||
      lower.includes("stop") ||
      lower.includes("quit") ||
      lower.includes("close")
    ) {
      sessions.delete(sessionKeyFor(req));

      return res.json(buildAlexaResponse("Exiting AI mode. Goodbye!", true));
    }

    if (
      lower.includes("new topic") ||
      lower.includes("don't want to continue") ||
      lower.includes("forget that") ||
      lower.includes("something else") ||
      lower.includes("change topic") ||
      lower.includes("another topic")
    ) {
      resetChatHistory(chatMemory);
    }

    addUserMessage(chatMemory, userQuery);

    const message = await runConversationTurn(chatMemory);

    log("AI Reply:", message.content);

    addAssistantMessage(chatMemory, message);
    trimHistory(chatMemory, 20);

    return res.json(buildAlexaResponse(message.content, false));
  } catch (error) {
    logError("Error in /alexa:", error?.stack || error);

    return res.json(buildAlexaResponse("Something went wrong", false));
  }
});

export default router;
