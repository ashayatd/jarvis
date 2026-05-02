
import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
// Logging utility
const log = (...args) => console.log("[LOG]", ...args);
const logError = (...args) => console.error("[ERROR]", ...args);

dotenv.config();


const app = express();
app.use(express.json());

// Log all incoming requests
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  log("Headers:", req.headers);
  next();
});


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// app.post("/alexa", async (req, res) => {
//   try {
//     const intent = req.body.request?.intent;

//     let userQuery = intent?.slots?.query?.value || "Hello";

//     console.log("User Query:", userQuery);

//     const response = await openai.responses.create({
//       model: "gpt-4.1-mini",
//       input: userQuery,
//     });

//     const reply = response.output_text || "Sorry, I didn't get that.";

//     return res.json({
//       version: "1.0",
//       response: {
//         outputSpeech: {
//           type: "PlainText",
//           text: reply,
//         },
//         shouldEndSession: false,
//       },
//     });
//   } catch (error) {
//     console.error(error);

//     return res.json({
//       version: "1.0",
//       response: {
//         outputSpeech: {
//           type: "PlainText",
//           text: "Something went wrong.",
//         },
//         shouldEndSession: false,
//       },
//     });
//   }
// });


app.post("/alexa", async (req, res) => {
  try {
    log("/alexa endpoint hit");
    log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;
    log("Request Type:", requestType);

    // ✅ HANDLE: "open jarvis"
    if (requestType === "LaunchRequest") {
      log("LaunchRequest detected. Sending activation response.");
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
      log("Response:", JSON.stringify(response, null, 2));
      return res.json(response);
    }

    // ✅ HANDLE: user query
    let userQuery = req.body.request?.intent?.slots?.query?.value || "Hello";
    log("User Query:", userQuery);

    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: userQuery,
    });

    log("AI Response:", aiResponse);
    const reply = aiResponse.output_text || "Sorry, I didn't get that.";

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
    log("Response:", JSON.stringify(response, null, 2));
    return res.json(response);
  } catch (error) {
    logError("Error in /alexa handler:", error);
    const response = {
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: "Something went wrong",
        },
        shouldEndSession: false,
      },
    };
    log("Error Response:", JSON.stringify(response, null, 2));
    return res.json(response);
  }
});

app.get("/", (req, res) => {
  log("GET / endpoint hit");
  res.send("Jarvis API Running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log(`Server running on port ${port}...`);
});
