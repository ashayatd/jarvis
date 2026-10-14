# Jarvis (Pluto)

A voice-controlled coding assistant. You talk to an Alexa skill called
**Pluto**; it opens projects in VS Code, runs git and npm, starts and stops dev
servers, and hands coding work to the Claude CLI — on your own Windows PC. An
LLM decides what to do, and almost every design choice is shaped by one limit:
**Alexa waits about 8 seconds for an answer.**

## Architecture

```
You speak
   │
   ▼
Alexa cloud ── skill "pluto", one catch-all intent (alexa/interaction-model.json)
   │  HTTPS via tunnel
   ▼
Node / Express  POST /alexa                     src/routes/alexaRoutes.js
   │  session memory, turn loop, deadlines, SSML
   │
   ├──► LLM service                             src/services/llmService.js
   │       Groq gpt-oss-120b  (primary)         providers/groqProvider.js
   │       Ollama qwen2.5:3b  (local fallback)  providers/ollamaProvider.js
   │
   ├──► Tools                                   src/tools/registry.js
   │       allowlist + workspace confinement
   │
   └──► Job registry (in memory)                src/data/jobRegistry.js
           background work, dev servers
   │
   │  HTTP + X-Executor-Secret
   ▼
Python / Flask  POST /execute                   executor.py
   runs everything inside EXECUTOR_WORKDIR (C:/projects/alexaProjects):
   shell commands, VS Code, the Claude CLI, long-lived dev servers
```

**A turn.** The route extracts what was said, handles stop/help/thanks
directly, and otherwise runs the agent loop: ask the LLM, run any tools it
requests, feed the results back, and repeat (at most two tool rounds). The reply
is converted to SSML and spoken.

**Tools.** `check_directory`, `open_project`, `init_project`, `run_command`,
`run_claude`, `check_running_servers`, `stop_server`, `check_background_jobs`,
`open_app`. Pluto acts without asking for confirmation, so `run_command` is
bounded by rules rather than by a spoken yes:

- an allowlist of command prefixes (`git`, `npm`, `node`, `python`, `dir`, `type`, …);
- `npx` may only run `create-vite`, `create-next-app`, `create-react-app` or `serve`;
- `start` may only open an `http(s)` URL or a named browser/notepad;
- no shell metacharacters, so commands cannot be chained;
- no absolute paths and no `..`, so nothing outside the workspace can be named.

**The time budget.** Two deadlines keep a turn inside Alexa's 8 seconds:

| Deadline | Default | What happens when it fires |
|---|---|---|
| `TOOL_DEADLINE_MS` | 3500 | A single slow tool keeps running as a background job |
| `TURN_DEADLINE_MS` | 4000 | The whole turn keeps running as a background job; Pluto says it is shifting to the background and closes the session |

Nothing is cancelled when a deadline fires: the same promise is handed to the
job registry. When the user re-opens the skill, finished work is mentioned
unprompted, or reported on "is it done?".

**The executor** distinguishes three shapes of command: instant ones answer
inline; slow-but-finite ones (installs, Claude runs) start in a thread and are
polled by job id; dev servers are spawned, checked once to see they survived,
and left running, with their `localhost` address read from their output.

## LLM failover

`llmService.js` is the only thing the agent loop talks to. Both providers take
the same messages and tool schemas and return the same OpenAI-shaped message,
so nothing downstream knows which one answered.

```
generate()
  │
  ├─ breaker open? ──yes──────────────────────────────┐
  │                                                   │
  no                                                  │
  ▼                                                   ▼
Groq (timeout GROQ_TIMEOUT_MS) ──ok──► answer      Ollama ──► answer
  │                                                   ▲       (or error)
  └─ timeout / network / 429 / 5xx ──► open breaker ──┘
     400 / 401 / other ──► throw (a bug, not an outage)
```

- **Failover** happens on a timeout, a network error, a 429 or a 5xx. Other
  errors are thrown: a bad key or a malformed request is not fixed by asking a
  different model, and answering from the fallback would hide it.
- **Circuit breaker.** After a Groq failure, Groq is skipped for
  `BREAKER_COOLDOWN_MS` (60s), so an outage costs one timeout, not one per turn.
  A 429 that says when to come back is believed instead: the breaker stays open
  for exactly that long, read from `retry-after-ms`, then `retry-after`
  (seconds or an HTTP date), then Groq's "try again in 18.7s" wording. The
  first call after the cooldown tries Groq again; success closes the breaker,
  failure re-opens it.
- **The timeout is enforced by the service**, not only the SDK: the request is
  aborted and raced against a timer, so a provider that ignores the abort still
  cannot hold the turn. Groq's own SDK retries are disabled for the same reason.
- **Warm-up at start.** Groq gets one tiny call (`GROQ_WARMUP`, default on),
  so the first real turn is not a cold one - unwarmed, the first call of a
  session was measured at 2-4 s against a 2 s timeout. Ollama loads the model
  (`OLLAMA_WARMUP`, default on), and every Ollama request carries `keep_alive`
  (`OLLAMA_KEEP_ALIVE`, default `30m`) so it stays loaded. A cold qwen2.5:3b
  took about 5 s on its first call; warm calls take 0.2-0.7 s.
- **The time budget still applies.** A slow local answer is not waited for: the
  turn deadline fires as usual, the turn becomes a background job, and the
  answer is delivered when the user comes back.
- **Logging.** Each model call logs the provider, its latency and why it fell
  back; each turn ends with a summary, e.g.
  `[TURN] complete in 1049ms llm=ollama 639ms + ollama 379ms`.
- **Malformed tool calls.** Small local models sometimes send arguments that
  are not JSON, name a tool that does not exist, or write the tool call into the
  text. Unusable calls are dropped (usable ones beside them are kept), and a
  reply left with nothing to run is spoken as a plain "could you say it another
  way" rather than crashing the turn or reading JSON aloud.

Set `LLM_PRIMARY=ollama` to make the local model primary and Groq the fallback.

### Measured on this machine

i5-14450HX, RTX 3050 6 GB, one tool-calling turn (model → tool call → model):

| | Groq gpt-oss-120b | Ollama qwen2.5:3b (warm, fully on GPU) |
|---|---|---|
| Typical turn | 1.3-2.0 s (median ~1.6 s) | 0.6-1.1 s |
| Worst seen | 5.9 s (first call of a session) | 5.5 s (cold model load) |
| Picks the right tool | yes | 5/5 well-formed calls, but the wrong tool or a stopped workflow in 2-3 of 5 turns |

The local model is faster but noticeably less capable: it tends to stop after
`check_directory` and ask instead of acting, and paraphrases numbers from tool
results wrongly. Treat it as a way to keep answering during an outage, not as
an equal.

### Ollama context window

Ollama loaded qwen2.5:3b with a 4,096-token context. The system prompt and tool
schemas alone are about 1,500 tokens, leaving roughly 2,600 for history and tool
output, and Ollama silently drops the start of a prompt that does not fit. For
longer sessions, raise it on the Ollama server (`OLLAMA_CONTEXT_LENGTH=8192`)
or with a Modelfile `PARAMETER num_ctx 8192`.

### Tokens per turn

Every model call sends the system prompt and all nine tool schemas, and a
tool-calling turn makes at least two calls. Both are written so that each rule
is stated once - in the prompt or in a tool's description, not both. Measured
on Groq, the same five real turns before and after that rewrite:

| Turn | Calls | Before | After |
|---|---|---|---|
| Fixed prompt, per call | - | ~2,600 | ~1,310 |
| One tool (servers, background jobs) | 2 | 5,290-5,470 | 2,760-2,770 |
| check_directory, then act (open, git status, list files) | 3 | 8,230-8,370 | 4,340-4,580 |

History is kept to the last 12 messages, and tool results from earlier turns
are cut to 200 characters when sent (the current turn's are sent whole).

### Groq free tier

The free tier allows 8,000 tokens per minute for `gpt-oss-120b`. That is now
about two tool-calling turns a minute; beyond it Groq answers 429, the breaker
opens for as long as the 429 says, and the local model answers meanwhile.

## Running it

```
cp .env.example .env          # then fill in GROQ_API_KEY and EXECUTOR_SECRET
npm install
pip install -r requirements.txt
ollama pull qwen2.5:3b        # optional, for the local fallback

python executor.py            # refuses to start without EXECUTOR_SECRET
npm start                     # Node service on PORT (3000)
```

Expose the Node service through a tunnel and point the Alexa skill's endpoint
at `https://<tunnel>/alexa`. Deploying the interaction model is described in
[alexa/README.md](alexa/README.md).

Configuration is listed, with comments, in [.env.example](.env.example).

## Tests

```
npm test
```

Node's built-in test runner. The LLM is mocked everywhere; `voice.test.mjs`
starts the real `executor.py` against a throwaway workspace.

## Limits worth knowing

- **State is in memory.** Restarting the Node service forgets conversations,
  background jobs and which dev servers it started (the processes keep running).
- **Autonomous by design.** Nothing asks for confirmation; the allowlist and
  workspace confinement are the whole boundary.
- **Single user.** Jobs and servers are shared across sessions on purpose:
  there is one user and one PC.
