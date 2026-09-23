// Every line carries a wall-clock timestamp and, where relevant, a session or
// job id and an elapsed time. When something misbehaves at 11pm the log should
// answer "what happened, to whom, and how long did it take" without a rerun.

const stamp = () => new Date().toISOString().slice(11, 23);

const write = (stream, level, args) => {
  stream(`${stamp()} ${level}`, ...args);
};

export const log = (...args) => write(console.log, "[LOG ]", args);
export const logWarn = (...args) => write(console.warn, "[WARN]", args);
export const logError = (...args) => write(console.error, "[ERR ]", args);

// Visually separates one Alexa turn from the next in a long scrollback.
export const logTurn = (sessionKey, query, intent) => {
  console.log("");
  console.log(
    `${stamp()} ${"=".repeat(60)}`,
  );
  console.log(
    `${stamp()} [TURN] session=${sessionKey}`,
    intent ? `intent=${intent}` : "",
    `query="${query}"`,
  );
};

// Returns a function that reports elapsed ms since creation.
export const startTimer = () => {
  const begin = Date.now();
  return () => Date.now() - begin;
};

// Trims anything long enough to bury the rest of the line.
export const preview = (value, max = 300) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);

  if (text === undefined) {
    return "undefined";
  }

  return text.length > max ? `${text.slice(0, max)}...[+${text.length - max} chars]` : text;
};
