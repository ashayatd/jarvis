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
export const registerJob = ({ sessionKey, label, promise, startedAt = Date.now() }) => {
  sweepJobs();

  const id = nextJobId();

  const job = {
    id,
    sessionKey,
    label,
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

const jobsForSession = (sessionKey) =>
  [...jobs.values()].filter((job) => job.sessionKey === sessionKey);

export const getSessionJobs = (sessionKey) => {
  sweepJobs();
  return jobsForSession(sessionKey);
};

// Finished work this session has not been told about yet.
export const takeUnreportedJobs = (sessionKey) => {
  const ready = jobsForSession(sessionKey).filter(
    (job) => job.status !== "running" && !job.reported,
  );

  for (const job of ready) {
    job.reported = true;
  }

  if (ready.length) {
    log(`[JOB ] ${ready.length} unreported result(s) for session=${sessionKey}`);
  }

  return ready;
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
