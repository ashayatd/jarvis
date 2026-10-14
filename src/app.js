import express from "express";
import dotenv from "dotenv";
import alexaRoutes from "./routes/alexaRoutes.js";
import { log } from "./utils/logger.js";

// server.js already loads this before the import graph runs; kept so importing
// app.js directly still works.
dotenv.config();

const app = express();

// Printed once at boot so a misread .env is obvious immediately rather than
// showing up as a 401 from the executor twenty minutes later.
log("=".repeat(60));
log("AI mode starting");
log(`  llm primary    : ${process.env.LLM_PRIMARY || "groq (default)"}`);
log(`  groq model     : ${process.env.GROQ_MODEL || "openai/gpt-oss-120b (default)"} timeout ${process.env.GROQ_TIMEOUT_MS || 2000}ms`);
log(`  groq key       : ${process.env.GROQ_API_KEY ? "set" : "MISSING"}`);
log(`  ollama         : ${process.env.OLLAMA_MODEL || "qwen2.5:3b"} at ${process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1"}`);
log(`  breaker        : ${process.env.BREAKER_COOLDOWN_MS || 60000}ms cooldown`);
log(`  executor url   : ${process.env.EXECUTOR_URL || process.env.VSCODE_AUTOMATION_URL || "http://127.0.0.1:5000/execute (default)"}`);
log(`  executor secret: ${process.env.EXECUTOR_SECRET ? "set (header will be sent)" : "NOT SET - no auth header will be sent"}`);
log(`  tool deadline  : ${process.env.TOOL_DEADLINE_MS || 3500}ms`);
log(`  exec timeouts  : inline ${process.env.EXECUTOR_TIMEOUT_MS || 4000}ms / background ${process.env.EXECUTOR_BG_TIMEOUT_MS || 120000}ms`);
log("=".repeat(60));

app.use(express.json());
app.use((req, res, next) => {
  log(`Incoming ${req.method} ${req.url}`);
  next();
});

app.use(alexaRoutes);

app.get("/", (req, res) => {
  res.send("AI mode running 🚀");
});

export default app;
