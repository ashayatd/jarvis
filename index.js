import express from "express";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// Logging
const log = (...args) => console.log("[LOG]", ...args);
const logError = (...args) => console.error("[ERROR]", ...args);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-flash-latest",
});

const app = express();
app.use(express.json());

// 🧠 Simple in-memory conversation
let chatHistory = [];

// Log requests
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  next();
});

app.post("/alexa", async (req, res) => {
  try {
    log("/alexa endpoint hit");
    log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;
    const intentName = req.body.request?.intent?.name;

    // ✅ Launch Request
    if (requestType === "LaunchRequest") {
      return res.json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "AI mode activated. How can I assist you?",
          },
          shouldEndSession: false,
        },
      });
    }

    // 🧠 Extract user query (handle fallback too)
    let userQuery =
      req.body.request?.intent?.slots?.query?.value ||
      req.body.request?.inputTranscript ||
      "Hello";

    log("User Query:", userQuery);

    const lower = userQuery.toLowerCase();

    // 🚪 Exit command
    if (
      lower.includes("exit") ||
      lower.includes("stop") ||
      lower.includes("quit") ||
      lower.includes("close")
    ) {
      chatHistory = [];

      return res.json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Exiting AI mode. Goodbye!",
          },
          shouldEndSession: true,
        },
      });
    }

    // 🧠 Add to memory
    chatHistory.push(`User: ${userQuery}`);

    // 🧠 Prompt with context
    const prompt = `
You are AI mode, a smart, slightly witty assistant.

Conversation so far:
${chatHistory.join("\n")}

Rules:
- Be short and conversational
- If user says things like "I choose 1", understand based on previous response
- Maintain context

Respond to the latest user message.
`;

    // 🤖 Gemini call
    const result = await model.generateContent(prompt);
    const reply =
      result.response.text() || "Sorry, I didn't get that.";

    log("AI Reply:", reply);

    // 🧠 Save AI response
    chatHistory.push(`AI: ${reply}`);

    return res.json({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: reply,
        },
        shouldEndSession: false,
      },
    });
  } catch (error) {
    logError("Error in /alexa handler:", error);

    return res.json({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: "Something went wrong",
        },
        shouldEndSession: false,
      },
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("AI mode is active. API Running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log(`Server running on port ${port}`);
});