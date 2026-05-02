const express = require("express");
const OpenAI = require("openai");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/alexa", async (req, res) => {
  try {
    const intent = req.body.request?.intent;

    let userQuery = intent?.slots?.query?.value || "Hello";

    console.log("User Query:", userQuery);

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: userQuery,
    });

    const reply = response.output_text || "Sorry, I didn't get that.";

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
    console.error(error);

    return res.json({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: "Something went wrong.",
        },
        shouldEndSession: false,
      },
    });
  }
});

app.get("/", (req, res) => {
  res.send("Jarvis API Running 🚀");
});

app.listen(process.env.PORT, () => {
  console.log("Server running...");
});
