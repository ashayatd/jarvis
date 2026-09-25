import { log, logError, preview } from "../utils/logger.js";

// In-memory only, by design. Jobs die with the process - acceptable while a
// job is at most a couple of minutes of PC automation.
const jobs = new Map();

const JOB_TTL_MS = 30 * 60 * 1000;

let counter = 0;

const nextJobId = () => {
  counter += 1;
  return `job${String(counter).padStart(3, "0")}`;
};

const sweepJobs = () => {
  const now = Date.now();
  let removed = 0;

  for (const [id, job] of jobs) {
    const age = now - (job.finishedAt ?? job.startedAt);

    if (job.status !== "running" && age > JOB_TTL_MS) {
      jobs.delete(id);
      removed += 1;
    }
  }

  if (removed) {
    log(`[JOB ] swept ${removed} expired job(s), ${jobs.size} remaining`);
  }
};

// Takes the still-running promise and records its outcome whenever it lands.
// Nothing awaits this - that is the whole point.
export const registerJob = ({
  sessionKey,
  label,
  promise,
  startedAt = Date.now(),
  narration = null,
}) => {
  sweepJobs();

  const id = nextJobId();

  const job = {
    id,
    sessionKey,
    label,
    // What to say while this is still going, so a reprompt can narrate the work
    // rather than repeating one line. Set by whoever started the job, because
    // the label is written for the model and reads badly out loud.
    narration,
    status: "running",
    result: null,
    error: null,
    startedAt,
    finishedAt: null,
    durationMs: null,
    reported: false,
  };

  jobs.set(id, job);
  log(`[JOB ] ${id} created session=${sessionKey} label="${label}" (${jobs.size} tracked)`);

  promise
    .then((result) => {
      job.status = result?.ok === false ? "failed" : "done";
      job.result = result;
      job.error = result?.ok === false ? result.error : null;
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - startedAt;

      log(
        `[JOB ] ${id} ${job.status} after ${job.durationMs}ms -> ${preview(result, 200)}`,
      );
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.message;
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - startedAt;

      logError(`[JOB ] ${id} threw after ${job.durationMs}ms: ${error.message}`);
    });

  return job;
};

// Read across every session, on purpose. An Alexa sessionId is new each time
// the skill is opened, so a job outlives the conversation that started it by
// definition - and the whole point of a background job is that the user can
// come back later and ask. Scoping these by session would have meant a job
// finishing into a conversation that no longer exists, with nobody able to ask
// about it. There is one user and one PC here, so "every session" is "theirs".
export const getAllJobs = () => {
  sweepJobs();

  return [...jobs.values()];
};

// Finished work nobody has been told about yet.
export const takeUnreportedJobs = () => {
  const ready = getAllJobs().filter((job) => job.status !== "running" && !job.reported);

  for (const job of ready) {
    job.reported = true;
  }

  if (ready.length) {
    log(`[JOB ] ${ready.length} unreported result(s)`);
  }

  return ready;
};

// Servers this session started, which are not jobs: nothing is waiting on one,
// and it outlives the turn that started it. Tracked only so "stop the server"
// knows what to stop - the executor owns the actual process.
//
// Deliberately not swept and not cleared when a session ends. A dev server is
// meant to outlive the conversation, and killing one because the user said
// goodbye would be a surprising way to lose your work.
const daemons = new Map();

export const registerDaemon = ({ sessionKey, remoteId, command, cwd = null, url = null }) => {
  daemons.set(remoteId, { remoteId, sessionKey, command, cwd, url, startedAt: Date.now() });

  log(`[DMN ] ${remoteId} tracked session=${sessionKey} "${command}" (${daemons.size} running)`);

  return remoteId;
};

export const getAllDaemons = () => [...daemons.values()];

// Only for telling the user which servers this conversation started. Anything
// that acts on servers reads all of them, for the same reason jobs do.
export const getSessionDaemons = (sessionKey) =>
  [...daemons.values()].filter((daemon) => daemon.sessionKey === sessionKey);

export const forgetDaemon = (remoteId) => {
  if (daemons.delete(remoteId)) {
    log(`[DMN ] ${remoteId} released (${daemons.size} running)`);
  }
};

export const daemonCount = () => daemons.size;

// Work still in flight, oldest first, for the reprompt to narrate. Does not
// touch `reported` - hearing about a job in a reprompt is not the same as being
// told it finished.
export const getRunningJobs = () => getAllJobs().filter((job) => job.status === "running");

// Neither of these is called from the request path any more: a session ending
// is not a reason to forget work that is still running, which was the bug. They
// exist for tests, which read globally now and so need a way to start from
// nothing.
export const clearAllJobs = () => {
  const removed = jobs.size;

  jobs.clear();

  if (removed) {
    log(`[JOB ] cleared all ${removed} job(s)`);
  }
};

export const clearSessionJobs = (sessionKey) => {
  let removed = 0;

  for (const [id, job] of jobs) {
    if (job.sessionKey === sessionKey) {
      jobs.delete(id);
      removed += 1;
    }
  }

  if (removed) {
    log(`[JOB ] cleared ${removed} job(s) for session=${sessionKey}`);
  }
};

// What the model is allowed to see. Internals like the promise stay out.
export const describeJob = (job) => ({
  job_id: job.id,
  what: job.label,
  status: job.status,
  ...(job.durationMs !== null ? { took_seconds: Math.round(job.durationMs / 1000) } : {}),
  ...(job.status === "done" ? { result: job.result } : {}),
  ...(job.status === "failed" ? { error: job.error } : {}),
});

export const jobCount = () => jobs.size;
