import os
import shutil
import subprocess
import threading
import time
import uuid
from dotenv import load_dotenv
from flask import Flask, request, jsonify

HERE = os.path.dirname(os.path.abspath(__file__))

# The Node side reads this same .env, and until now this process did not, so
# any setting put there was silently ignored here - EXECUTOR_SECRET included,
# which only worked because it happened to match the default below. Existing
# environment variables still win, so the tests can override.
load_dotenv(os.path.join(HERE, ".env"))

app = Flask(__name__)

SECRET = os.environ.get("EXECUTOR_SECRET", "jarvis_secret_123")

# Where every command runs, and the one setting that decides which project the
# Claude CLI edits: it acts on the directory it was started in. This is the
# workspace, deliberately not this repo - run_claude builds the user's
# projects, it does not edit Jarvis itself.
DEFAULT_WORKDIR = os.path.normpath("C:/projects/alexaProjects")
WORKDIR = os.environ.get("EXECUTOR_WORKDIR") or DEFAULT_WORKDIR

# Created at import rather than in __main__, so it exists however this module
# is started. Without it every job would fail on cwd before it ran anything.
try:
    os.makedirs(WORKDIR, exist_ok=True)
except OSError as error:
    print(f"[EXEC] WARNING: could not create workdir {WORKDIR}: {error}")

# A `claude -p "..."` run is minutes, not seconds. Nothing that long may hold a
# Flask worker, so it runs in a thread and the caller polls job_status.
JOB_TIMEOUT_S = int(os.environ.get("EXECUTOR_JOB_TIMEOUT", "900"))


def _resolve_claude():
    """Absolute path to the Claude CLI.

    PATH is not enough: this is often started from a shell or a service that
    never sourced the profile that adds the install directory, so the usual
    location is checked too.
    """
    override = os.environ.get("EXECUTOR_CLAUDE_BIN")

    if override:
        return override

    found = shutil.which("claude")

    if found:
        return found

    for name in ("claude.exe", "claude"):
        candidate = os.path.join(os.path.expanduser("~"), ".local", "bin", name)

        if os.path.isfile(candidate):
            return candidate

    return "claude"


CLAUDE_BIN = _resolve_claude()

# Finished jobs are kept only long enough for the caller to read them back.
JOB_TTL_S = 30 * 60

# Output is fed to an LLM and then spoken aloud, so the tail is what matters.
MAX_OUTPUT_CHARS = 4000

_jobs = {}
_jobs_lock = threading.Lock()


def _sweep_jobs():
    now = time.time()

    with _jobs_lock:
        expired = [
            job_id
            for job_id, job in _jobs.items()
            if job["status"] != "running" and now - job["finished_at"] > JOB_TTL_S
        ]

        for job_id in expired:
            del _jobs[job_id]

    if expired:
        print(f"[EXEC] swept {len(expired)} expired job(s)")


def _finish(job_id, status, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)

        if job is None:
            return

        job["status"] = status
        job["finished_at"] = time.time()
        job.update(fields)


def _run_job(job_id, command, use_shell, label):
    started = time.time()
    print(f"[EXEC] {job_id} running: {label}")

    try:
        result = subprocess.run(
            command,
            shell=use_shell,
            capture_output=True,
            text=True,
            timeout=JOB_TIMEOUT_S,
            cwd=WORKDIR,
            # Without this an interactive prompt (the Claude CLI asking to
            # trust a folder, say) waits on a stdin that nobody will ever
            # write to, and the job hangs until the timeout instead of
            # failing fast.
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        print(f"[EXEC] {job_id} timed out after {JOB_TIMEOUT_S}s")
        _finish(job_id, "failed", error=f"'{label}' timed out after {JOB_TIMEOUT_S} seconds.")
        return
    except FileNotFoundError:
        print(f"[EXEC] {job_id} not found: {command[0] if isinstance(command, list) else command}")
        _finish(job_id, "failed", error=f"'{label}' could not be started - is the command installed?")
        return
    except Exception as error:  # noqa: BLE001 - the thread must never die silently
        print(f"[EXEC] {job_id} failed to start: {error}")
        _finish(job_id, "failed", error=str(error))
        return

    output = (result.stdout.strip() or result.stderr.strip() or "(no output)")[-MAX_OUTPUT_CHARS:]
    elapsed = round(time.time() - started, 1)
    print(f"[EXEC] {job_id} rc={result.returncode} in {elapsed}s, {len(output)} chars")

    if result.returncode == 0:
        _finish(job_id, "done", output=output, returncode=result.returncode)
    else:
        _finish(
            job_id,
            "failed",
            output=output,
            returncode=result.returncode,
            error=f"'{label}' exited with code {result.returncode}.",
        )


def _start_job(command, use_shell=True, label=None):
    _sweep_jobs()

    job_id = f"x{uuid.uuid4().hex[:8]}"
    label = label or (command if isinstance(command, str) else " ".join(command))

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "command": label,
            "started_at": time.time(),
            "finished_at": None,
        }

    # Daemon, so a stuck job cannot keep the executor alive on shutdown.
    threading.Thread(
        target=_run_job, args=(job_id, command, use_shell, label), daemon=True
    ).start()

    return job_id


@app.route('/execute', methods=['POST'])
def execute():
    if request.headers.get('X-Executor-Secret') != SECRET:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.json
    command = data.get("command")

    if command == "open_vscode":
        # The path is passed explicitly rather than relying on ".", so the
        # window lands on the workspace no matter where this was started from.
        subprocess.run(f'code "{WORKDIR}"', shell=True, cwd=WORKDIR)
        return jsonify({"ok": True, "output": f"VS Code launched on {WORKDIR}."})

    if command == "run_command":
        shell_command = data.get("args", {}).get("command", "")

        if not shell_command:
            return jsonify({"ok": False, "error": "No command provided."}), 400

        # shell=True runs whatever arrives here. Two things keep that safe and
        # both have to stay true: the Node side allowlists commands before they
        # are sent, and Flask binds 127.0.0.1 so nothing off this machine can
        # reach it. If this is ever put behind a tunnel it needs its own
        # allowlist - the Node one would no longer be in the path.
        print(f"[EXEC] running: {shell_command}")

        try:
            result = subprocess.run(
                shell_command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=15,
                cwd=WORKDIR,
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            print(f"[EXEC] timed out after 15s: {shell_command}")
            return jsonify({"ok": False, "error": f"'{shell_command}' timed out after 15 seconds."}), 400

        output = result.stdout.strip() or result.stderr.strip() or "(no output)"
        print(f"[EXEC] rc={result.returncode}, {len(output)} chars returned")

        return jsonify({"ok": True, "output": output})

    # Same shell as run_command, but the reply comes back immediately with an
    # id instead of the output. Used for anything the caller cannot afford to
    # hold a request open for.
    if command == "start_command":
        shell_command = data.get("args", {}).get("command", "")

        if not shell_command:
            return jsonify({"ok": False, "error": "No command provided."}), 400

        return jsonify(
            {"ok": True, "status": "running", "job_id": _start_job(shell_command, use_shell=True)}
        )

    # No shell anywhere on this path. The prompt goes to the CLI as one argv
    # entry, so $, (), quotes and newlines in it are plain text - there is no
    # shell to interpret them and nothing to escape.
    if command == "start_claude":
        prompt = data.get("args", {}).get("prompt", "")

        if not prompt:
            return jsonify({"ok": False, "error": "No prompt provided."}), 400

        job_id = _start_job(
            [CLAUDE_BIN, "-p", prompt],
            use_shell=False,
            label=f"claude: {prompt}",
        )

        return jsonify({"ok": True, "status": "running", "job_id": job_id})

    if command == "job_status":
        job_id = data.get("args", {}).get("job_id", "")

        with _jobs_lock:
            job = _jobs.get(job_id)
            snapshot = dict(job) if job else None

        if snapshot is None:
            return jsonify({"ok": False, "error": f"Unknown job: {job_id}"}), 404

        response = {
            "ok": snapshot["status"] != "failed",
            "status": snapshot["status"],
            "job_id": job_id,
            "command": snapshot["command"],
            "elapsed_seconds": round(
                (snapshot["finished_at"] or time.time()) - snapshot["started_at"], 1
            ),
        }

        for field in ("output", "error", "returncode"):
            if field in snapshot:
                response[field] = snapshot[field]

        return jsonify(response)

    return jsonify({"ok": False, "error": f"Unknown command: {command}"}), 400


if __name__ == '__main__':
    print(f"[EXEC] workdir: {WORKDIR}")
    print(f"[EXEC] claude : {CLAUDE_BIN}")
    # threaded is the default, but it is the thing that makes job_status
    # answerable while a job is still running, so it is set explicitly.
    app.run(port=int(os.environ.get("EXECUTOR_PORT", "5000")), threaded=True)
