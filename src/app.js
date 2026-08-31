import express from "express";
import dotenv from "dotenv";
import alexaRoutes from "./routes/alexaRoutes.js";
import { log } from "./utils/logger.js";

dotenv.config();
log("AI mode starting with Groq...");

const app = express();

app.use(express.json());
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  next();
});

app.use(alexaRoutes);

app.get("/", (req, res) => {
  res.send("AI mode running with Groq 🚀");
});

export default app;
