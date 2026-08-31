import express from "express";
import {
  addAssistantMessage,
  addUserMessage,
  createChatMemory,
  resetChatHistory,
  trimHistory,
} from "../data/chatMemory.js";
import { generateAIReply } from "../services/groqService.js";
import { openVSCode } from "../services/vscodeService.js";
import { log, logError } from "../utils/logger.js";

const router = express.Router();
const chatMemory = createChatMemory();

const buildAlexaResponse = (text, shouldEndSession = false) => ({
  version: "1.0",
  response: {
    outputSpeech: {
      type: "PlainText",
      text,
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

router.post("/alexa", async (req, res) => {
  try {
    log("/alexa endpoint hit");
    log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;

    if (requestType === "LaunchRequest") {
      return res.json(
        buildAlexaResponse("AI mode activated. How can I assist you?", false),
      );
    }

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
      resetChatHistory(chatMemory);

      return res.json(
        buildAlexaResponse("Exiting AI mode. Goodbye!", true),
      );
    }

    if (lower.includes("open vs code")) {
      try {
        await openVSCode();

        return res.json(
          buildAlexaResponse("Opening Visual Studio Code", false),
        );
      } catch (err) {
        logError("VS Code automation failed:", err);

        return res.json(
          buildAlexaResponse("I could not open Visual Studio Code", false),
        );
      }
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

    const reply = await generateAIReply(chatMemory);

    log("AI Reply:", reply);

    addAssistantMessage(chatMemory, reply);
    trimHistory(chatMemory, 20);

    return res.json(buildAlexaResponse(reply, false));
  } catch (error) {
    logError("Error in /alexa:", error);

    return res.json(
      buildAlexaResponse("Something went wrong", false),
    );
  }
});

export default router;
