import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

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
    console.log("REQUEST:", JSON.stringify(req.body, null, 2));

    const requestType = req.body.request?.type;

    // ✅ HANDLE: "open jarvis"
    if (requestType === "LaunchRequest") {
      return res.json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Jarvis activated. What do you want to know?",
          },
          shouldEndSession: false,
        },
      });
    }

    // ✅ HANDLE: user query
    let userQuery =
      req.body.request?.intent?.slots?.query?.value || "Hello";

    console.log("User Query:", userQuery);

    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: userQuery,
    });

    const reply =
      aiResponse.output_text || "Sorry, I didn't get that.";

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
          text: "Something went wrong",
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
