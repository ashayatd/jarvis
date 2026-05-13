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

    // 🧠 Memory add
    chatHistory.push(`User: ${userQuery}`);

    const prompt = `
You are AI mode, a smart, slightly witty assistant.

Conversation so far:
${chatHistory.join("\n")}

Rules:
- Be short and conversational
- Understand references like "I choose 1"
- Maintain context

Respond to the latest user message.
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

    // 🧠 Save response
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
