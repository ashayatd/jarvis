import express from "express";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();

// Logging
const log = (...args) => console.log("[LOG]", ...args);
const logError = (...args) => console.error("[ERROR]", ...args);

console.log(
  "Starting AI mode with Groq...",
  "GROQ_API_KEY:",
  process.env.GROQ_API_KEY,
);
// ✅ Groq setup
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const app = express();
app.use(express.json());

// 🧠 Memory
let chatHistory = [];

// Log requests
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  next();
});

app.post("/alexa", async (req, res) => {
      // Handle 'open vs code' command BEFORE AI call
      if (lower.includes("open vs code")) {
        await fetch("https://saturnina-preoceanic-domenica.ngrok-free.dev/execute", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            command: "open_vscode",
          }),
        });

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
      }
  try {
    log("/alexa endpoint hit");
    log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;

    // ✅ Launch
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

    log("Intent JSON:", JSON.stringify(req.body.request?.intent, null, 2));

    // 🧠 Extract query
    let userQuery =
      req.body.request?.intent?.slots?.query?.value ||
      req.body.request?.inputTranscript ||
      "Hello";

    log("User Query:", userQuery);

    const lower = userQuery.toLowerCase();

    // 🚪 Exit
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

    // 🔄 Topic reset
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

    // 🧠 Save USER message
    chatHistory.push(`User: ${userQuery}`);

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
    // 🤖 Groq call (FAST 🔥)
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are a smart AI assistant." },
        { role: "user", content: prompt },
      ],
    });

    const reply =
      completion.choices[0]?.message?.content || "Sorry, I didn't get that.";

    log("AI Reply:", reply);

    // 🔄 Topic reset
    if (
      lower.includes("new topic") ||
      lower.includes("don't want to continue") ||
      lower.includes("forget that") ||
      lower.includes("something else")
    ) {
      chatHistory = [];
    }

    // 🧠 Save USER message
    chatHistory.push(`User: ${userQuery}`);

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
    logError("Error:", error);

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

// Health
app.get("/", (req, res) => {
  res.send("AI mode running with Groq 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log(`Server running on port ${port}`);
});
