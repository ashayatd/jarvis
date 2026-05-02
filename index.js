import express from "express";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// Logging utility
const log = (...args) => console.log("[LOG]", ...args);
const logError = (...args) => console.error("[ERROR]", ...args);

// ✅ Initialize Gemini AFTER dotenv
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-flash-latest",
});
const app = express();
app.use(express.json());

// Log all incoming requests
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  next();
});

app.post("/alexa", async (req, res) => {
  try {
    log("/alexa endpoint hit");
    log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;
    log("Request Type:", requestType);

    // ✅ Launch Request (open jarvis)
    if (requestType === "LaunchRequest") {
      const response = {
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Jarvis activated. What do you want to know?",
          },
          shouldEndSession: false,
        },
      };
      return res.json(response);
    }

    // ✅ Intent Request (user query)
    let userQuery = req.body.request?.intent?.slots?.query?.value || "Hello";

    log("User Query:", userQuery);

    // 🧠 Add Jarvis personality
    const prompt = `You are Jarvis, a smart, slightly witty AI assistant. Keep responses short and conversational. User: ${userQuery}`;

    // ✅ Gemini call
    const result = await model.generateContent(prompt);
    const reply = result.response.text() || "Sorry, I didn't get that.";

    log("AI Reply:", reply);

    const response = {
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: reply,
        },
        shouldEndSession: false,
      },
    };

    return res.json(response);
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
  res.send("Jarvis API Running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log(`Server running on port ${port}`);
});
