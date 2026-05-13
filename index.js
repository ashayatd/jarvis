import express from "express";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();

// =========================
// Logging Helpers
// =========================
const log = (...args) => console.log("[LOG]", ...args);
const logError = (...args) => console.error("[ERROR]", ...args);

// =========================
// Groq Setup
// =========================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

log("AI mode starting with Groq...");

// =========================
// Express Setup
// =========================
const app = express();
app.use(express.json());

// =========================
// Simple Memory
// =========================
let chatHistory = [];

// =========================
// Request Logger
// =========================
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  next();
});

// =========================
// Alexa Endpoint
// =========================
app.post("/alexa", async (req, res) => {
  try {
    log("/alexa endpoint hit");
    log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;

    // =========================
    // Launch Request
    // =========================
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

    // =========================
    // Extract User Query
    // =========================
    const slots = req.body.request?.intent?.slots || {};
    log("Extracted Slots:", JSON.stringify(slots, null, 2));

    let userQuery = Object.values(slots)[0]?.value;

    if (!userQuery) {
      userQuery = req.body.request?.inputTranscript;
    }

    if (!userQuery) {
      return res.json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "I didn't catch that properly. Please say tell me followed by your question.",
          },
          shouldEndSession: false,
        },
      });
    }

    log("User Query:", userQuery);

    const lower = userQuery.toLowerCase();

    // =========================
    // Exit AI Mode
    // =========================
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

    // =========================
    // VS Code Automation
    // =========================
    if (lower.includes("open vs code")) {
      try {
        await fetch(
          "https://saturnina-preoceanic-domenica.ngrok-free.dev/execute",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              command: "open_vscode",
            }),
          },
        );

        return res.json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "Opening Visual Studio Code",
            },
            shouldEndSession: false,
          },
        });
      } catch (err) {
        logError("VS Code automation failed:", err);

        return res.json({
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "I could not open Visual Studio Code",
            },
            shouldEndSession: false,
          },
        });
      }
    }

    // =========================
    // Topic Reset
    // =========================
    if (
      lower.includes("new topic") ||
      lower.includes("don't want to continue") ||
      lower.includes("forget that") ||
      lower.includes("something else") ||
      lower.includes("change topic") ||
      lower.includes("another topic")
    ) {
      chatHistory = [];
    }

    // =========================
    // Save User Message
    // =========================
    chatHistory.push(`User: ${userQuery}`);

    // =========================
    // Prompt
    // =========================
    const prompt = `
You are AI mode, a smart and conversational assistant.

Conversation history:
${chatHistory.join("\n")}

Important behavior rules:
- Maintain conversational context naturally
- If the user changes topic, immediately switch topics
- Never force old topics into new conversations
- If the user says things like:
  "forget that",
  "new topic",
  "let's talk about something else",
  "I don't want to continue"
  then stop using previous topic context
- Keep responses short and voice-friendly for Alexa
- Understand references like "I choose 1"

Respond naturally to the latest user message only.
`;

    // =========================
    // AI Call
    // =========================
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: "You are a smart AI assistant.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 120,
    });

    const reply =
      completion.choices[0]?.message?.content || "Sorry, I didn't get that.";

    log("AI Reply:", reply);

    // =========================
    // Save AI Reply
    // =========================
    chatHistory.push(`AI: ${reply}`);

    // =========================
    // Prevent Infinite Memory Growth
    // =========================
    if (chatHistory.length > 20) {
      chatHistory = chatHistory.slice(-20);
    }

    // =========================
    // Final Alexa Response
    // =========================
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
    logError("Error in /alexa:", error);

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

// =========================
// Health Check
// =========================
app.get("/", (req, res) => {
  res.send("AI mode running with Groq 🚀");
});

// =========================
// Server Start
// =========================
const port = process.env.PORT || 3000;

app.listen(port, () => {
  log(`Server running on port ${port}`);
});
