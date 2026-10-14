import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dotenv import load_dotenv
from flask import Flask, request, jsonify

HERE = os.path.dirname(os.path.abspath(__file__))

# The Node side reads this same .env, and until now this process did not, so
# any setting put there was silently ignored here - EXECUTOR_SECRET included.
# Existing environment variables still win, so the tests can override.
load_dotenv(os.path.join(HERE, ".env"))

app = Flask(__name__)

# No default. A fallback secret is one anybody can read in this repo, and the
# endpoint runs shell commands - so a missing secret stops the process here
# rather than starting with a lock everyone has the key to.
SECRET = os.environ.get("EXECUTOR_SECRET")

if not SECRET:
    raise SystemExit(
        "[EXEC] EXECUTOR_SECRET is not set. Add it to .env (the same value the "
        "Node service sends) or the environment, then start the executor again."
    )

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

# Overridable so the tests can exercise the open/init flow without a real
# editor window appearing for every case.
VSCODE_BIN = os.environ.get("EXECUTOR_VSCODE_BIN", "code")

# Without this the CLI cannot write anything. In print mode it has no way to
# ask for permission to use Write or Edit - and stdin is /dev/null here by
# design - so it answers with the code as text and stops: "I've created
# hello.txt ... it just needs your permission to write the file". acceptEdits
# grants file edits up front, which is what makes a run autonomous. Set the
# variable to an empty string to go back to asking, or to
# "bypassPermissions" to allow everything.
CLAUDE_PERMISSION_MODE = os.environ.get("EXECUTOR_CLAUDE_PERMISSION_MODE", "acceptEdits")

# Finished jobs are kept only long enough for the caller to read them back.
JOB_TTL_S = 30 * 60

# Output is fed to an LLM and then spoken aloud, so the tail is what matters.
MAX_OUTPUT_CHARS = 4000

# How long to give a spawned server before deciding it survived. Long enough
# for a bad command, a missing script or a port clash to exit and be reported
# as the failure it is; short enough to stay inside Alexa's turn.
DAEMON_CONFIRM_S = float(os.environ.get("EXECUTOR_DAEMON_CONFIRM", "1.5"))

_jobs = {}
_jobs_lock = threading.Lock()

# Popen handles for the servers still up, kept so they are not garbage
# collected and so their status can be re-read later. Deliberately never
# waited on: a dev server does not exit, and waiting is the bug being fixed.
_daemons = {}

# Printed by every dev server worth opening: Vite's "Local: http://localhost:5173/",
# CRA's "On Your Network", and so on. Read out of the first seconds of output so
# the browser can be pointed at the real port rather than a guessed one.
_LOCAL_URL = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?/?\S*")


# Spoken project names arrive as "landing page", while the folder on disk is
# "landing-page". Everything that is not a letter or digit becomes a hyphen,
# which also strips separators and dots - so a name can never climb out of the
# workspace, whatever the model was told to pass.
def _slug(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").strip().lower()).strip("-")


def _list_projects():
    try:
        return sorted(
            entry for entry in os.listdir(WORKDIR)
            if os.path.isdir(os.path.join(WORKDIR, entry))
        )
    except OSError:
        return []


def _project_path(name):
    """Resolve a spoken name to (folder, existing_path_or_None) inside WORKDIR.

    A folder is also matched when its name only slugifies to the same thing,
    so "landing page" finds an existing "Landing Page" or "landingPage"
    instead of quietly creating a second directory beside it.
    """
    slug = _slug(name)

    if not slug:
        return None, None

    direct = os.path.join(WORKDIR, slug)

    # _slug cannot emit a separator, so this cannot fail - it is here so that
    # a future change to _slug cannot silently open a traversal.
    if os.path.dirname(os.path.abspath(direct)) != os.path.abspath(WORKDIR):
        print(f"[EXEC] REFUSED project name outside workspace: {name}")
        return None, None

    if os.path.isdir(direct):
        return slug, direct

    for entry in _list_projects():
        if _slug(entry) == slug:
            return entry, os.path.join(WORKDIR, entry)

    return slug, None


# The same confinement the Node side applies, repeated here on purpose. The
# note on run_command below says it plainly: if this is ever reached without
# the Node service in front of it, the allowlist is gone and this is the only
# check left. Keeping it in both places costs one function.
_ABSOLUTE_PATH = re.compile(r"""(?:^|[\s"'(=])(?:[A-Za-z]:|\\)""")
_TRAVERSAL = re.compile(r"\.\.")


def _escapes_workspace(command):
    return bool(_ABSOLUTE_PATH.search(command) or _TRAVERSAL.search(command))


# Secrets this process needs and its children have no business seeing. Loading
# .env put these on os.environ, and a child inherits it, so without this
# "node -p process.env.GROQ_API_KEY" reads the key straight out - a command
# with no metacharacters, no absolute path and no "..", so nothing else stops
# it. ANTHROPIC_API_KEY is deliberately not here: the Claude CLI needs it.
_PRIVATE_ENV = ("GROQ_API_KEY", "EXECUTOR_SECRET")


def _child_env():
    env = os.environ.copy()

    for name in _PRIVATE_ENV:
        env.pop(name, None)

    return env


def _resolve_within_workspace(relative):
    """Absolute path for a workspace-relative directory, or None if it escapes.

    Every segment goes through _slug, which is what makes this safe rather
    than merely careful: a segment cannot come back as "..", as a drive letter
    or as a separator, so there is nothing left to traverse with. An empty or
    missing value means the workspace root, which is the old behaviour.
    """
    segments = [_slug(part) for part in re.split(r"[/\\]+", str(relative or ""))]
    segments = [part for part in segments if part]
    root = os.path.abspath(WORKDIR)

    if not segments:
        return root

    candidate = os.path.abspath(os.path.join(root, *segments))

    # Belt to the braces above: if _slug is ever loosened, this still holds.
    if candidate != root and not candidate.startswith(root + os.sep):
        print(f"[EXEC] REFUSED cwd outside workspace: {relative}")
        return None

    return candidate


def _launch_vscode(path):
    subprocess.run(f'{VSCODE_BIN} "{path}"', shell=True, cwd=path)


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


def _remove_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        # A log left in the temp directory is not worth failing a request over.
        pass


def _kill_tree(proc, label):
    """Kill a spawned server and everything it started.

    proc.terminate() is not enough here. shell=True means the handle we hold is
    cmd.exe, and the node or python process doing the actual serving is its
    child - terminating the shell would leave that orphaned, still holding the
    port, and the next "npm run dev" would fail on an address already in use.
    taskkill /T walks the tree; /F does not ask it politely.
    """
    if os.name != "nt":
        proc.kill()

        return None

    killed = subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
        capture_output=True,
        text=True,
        timeout=15,
    )

    detail = (killed.stdout or killed.stderr or "").strip()
    print(f"[EXEC] taskkill rc={killed.returncode} for {label}: {detail}")

    # rc 128 is "no such process": already gone, which is the outcome asked for.
    if killed.returncode not in (0, 128):
        return detail or f"taskkill exited with {killed.returncode}"

    return None


def _reap_daemon(job_id, proc):
    """Record that a server has exited on its own, and clear up after it.

    Something has to notice. Nothing waits on a daemon, so a server that
    crashes stays marked running until the next time anyone looks - and its
    output file stays in the temp directory for good unless it is removed here.
    Safe to call repeatedly.
    """
    _daemons.pop(job_id, None)

    with _jobs_lock:
        job = _jobs.get(job_id)
        log_path = job.get("log") if job else None
        already_finished = bool(job and job["finished_at"])

    # Read before removing: whatever it printed on the way down is the answer to
    # "why did my server stop", and deleting the file first would throw it away.
    output = _read_tail(log_path) if log_path else ""

    if not already_finished:
        _finish(
            job_id,
            "done" if proc.returncode == 0 else "failed",
            returncode=proc.returncode,
            error=None if proc.returncode == 0 else f"exited with code {proc.returncode}",
            **({"output": output} if output else {}),
        )
        print(f"[EXEC] {job_id} exited on its own, rc={proc.returncode}")

    if log_path:
        _remove_quietly(log_path)


def _read_tail(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()[-MAX_OUTPUT_CHARS:].strip()
    except OSError:
        return ""


def _detect_url(output):
    """The address a dev server said it was listening on, if it said one."""
    match = _LOCAL_URL.search(output or "")

    if not match:
        return None

    url = match.group(0).rstrip(".,)")

    # 0.0.0.0 is a bind address, not something a browser should be sent to.
    return url.replace("0.0.0.0", "localhost")


def _start_daemon(shell_command, cwd, label):
    """Spawn a persistent process and report whether it survived its first
    seconds.

    Nothing here waits for the process to exit, because a dev server never
    does. Output goes to a file rather than a pipe on purpose: nobody is
    draining a pipe while the server runs, and a full pipe buffer would wedge
    it. A file can be read at any moment and never blocks the child.
    """
    _sweep_jobs()

    job_id = f"d{uuid.uuid4().hex[:8]}"
    started = time.time()

    log = tempfile.NamedTemporaryFile(
        prefix=f"pluto-{job_id}-", suffix=".log", delete=False, mode="w", encoding="utf-8"
    )

    log_path = log.name

    try:
        proc = subprocess.Popen(
            shell_command,
            shell=True,
            cwd=cwd or WORKDIR,
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    except OSError as error:
        log.close()
        _remove_quietly(log_path)
        print(f"[EXEC] {job_id} could not start: {error}")

        return {"ok": False, "error": f"'{label}' could not be started: {error}"}

    # Closed here, not later: the child holds its own descriptor and keeps
    # writing, while this handle would otherwise be the reason Windows refuses
    # to delete the file when the server is stopped.
    log.close()

    print(f"[EXEC] {job_id} spawned pid={proc.pid}: {label}")

    # The one wait in this function, and it is a confirmation rather than a
    # poll to completion: did it fall over straight away?
    time.sleep(DAEMON_CONFIRM_S)

    code = proc.poll()
    output = _read_tail(log_path)
    elapsed = round(time.time() - started, 1)

    with _jobs_lock:
        _jobs[job_id] = {
            "kind": "daemon",
            "status": "running" if code is None else ("done" if code == 0 else "failed"),
            "command": label,
            "cwd": cwd or WORKDIR,
            "pid": proc.pid,
            "log": log_path,
            "started_at": started,
            "finished_at": None if code is None else time.time(),
        }

    # Exited before the confirmation window. A server doing that has failed, but
    # a one-off script doing it has simply finished - the return code is what
    # separates them, and both are reported as what they are rather than as
    # "running in the background".
    if code is not None:
        _daemons.pop(job_id, None)
        _remove_quietly(log_path)
        print(f"[EXEC] {job_id} exited rc={code} after {elapsed}s")

        if code == 0:
            return {
                "ok": True,
                "status": "done",
                "started": False,
                "job_id": job_id,
                "returncode": 0,
                "output": output or "(no output)",
            }

        return {
            "ok": False,
            "status": "failed",
            "started": False,
            "job_id": job_id,
            "returncode": code,
            "error": f"'{label}' exited straight away with code {code}.",
            "output": output or "(no output)",
        }

    _daemons[job_id] = proc
    url = _detect_url(output)

    print(f"[EXEC] {job_id} still up after {elapsed}s url={url or '(none seen)'}")

    return {
        "ok": True,
        "status": "running",
        "started": True,
        "message": "Dev server is running in background",
        "job_id": job_id,
        "pid": proc.pid,
        **({"url": url} if url else {}),
        **({"output": output} if output else {}),
    }


def _finish(job_id, status, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)

        if job is None:
            return

        job["status"] = status
        job["finished_at"] = time.time()
        job.update(fields)


def _run_job(job_id, command, use_shell, label, cwd=None):
    started = time.time()
    print(f"[EXEC] {job_id} running: {label}")

    try:
        result = subprocess.run(
            command,
            shell=use_shell,
            capture_output=True,
            text=True,
            timeout=JOB_TIMEOUT_S,
            cwd=cwd or WORKDIR,
            env=_child_env(),
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


def _start_job(command, use_shell=True, label=None, cwd=None):
    _sweep_jobs()

    job_id = f"x{uuid.uuid4().hex[:8]}"
    label = label or (command if isinstance(command, str) else " ".join(command))

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "command": label,
            "cwd": cwd or WORKDIR,
            "started_at": time.time(),
            "finished_at": None,
        }

    # Daemon, so a stuck job cannot keep the executor alive on shutdown.
    threading.Thread(
        target=_run_job, args=(job_id, command, use_shell, label, cwd), daemon=True
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
        _launch_vscode(WORKDIR)
        return jsonify({"ok": True, "output": f"VS Code launched on {WORKDIR}."})

    if command == "run_command":
        shell_command = data.get("args", {}).get("command", "")

        if not shell_command:
            return jsonify({"ok": False, "error": "No command provided."}), 400

        if _escapes_workspace(shell_command):
            print(f"[EXEC] REFUSED, leaves the workspace: {shell_command}")
            return jsonify({
                "ok": False,
                "error": f"'{shell_command}' names a path outside the workspace.",
            }), 400

        run_cwd = _resolve_within_workspace(data.get("args", {}).get("cwd", ""))

        if run_cwd is None or not os.path.isdir(run_cwd):
            return jsonify({
                "ok": False,
                "error": f"'{data.get('args', {}).get('cwd')}' is not a project in the workspace.",
            }), 400

        # shell=True runs whatever arrives here. Three things keep that safe:
        # the Node side allowlists commands before they are sent, Flask binds
        # 127.0.0.1 so nothing off this machine can reach it, and the check
        # above confines the command to the workspace whether or not the Node
        # side ran. If this is ever put behind a tunnel it still wants its own
        # allowlist - the confinement check limits where a command can reach,
        # not which commands may run.
        print(f"[EXEC] running: {shell_command}")

        try:
            result = subprocess.run(
                shell_command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=15,
                cwd=run_cwd,
                env=_child_env(),
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

        if _escapes_workspace(shell_command):
            print(f"[EXEC] REFUSED, leaves the workspace: {shell_command}")
            return jsonify({
                "ok": False,
                "error": f"'{shell_command}' names a path outside the workspace.",
            }), 400

        job_cwd = _resolve_within_workspace(data.get("args", {}).get("cwd", ""))

        if job_cwd is None or not os.path.isdir(job_cwd):
            return jsonify({
                "ok": False,
                "error": f"'{data.get('args', {}).get('cwd')}' is not a project in the workspace.",
            }), 400

        where = os.path.relpath(job_cwd, os.path.abspath(WORKDIR))
        label = shell_command if where == "." else f"{shell_command} (in {where})"

        return jsonify({
            "ok": True,
            "status": "running",
            "cwd": job_cwd,
            "job_id": _start_job(shell_command, use_shell=True, label=label, cwd=job_cwd),
        })

    # A dev server, which is not a job that finishes. start_command would have
    # been polled to an exit that never comes and then killed at the job
    # timeout; this spawns it, checks it survived, and leaves it alone.
    if command == "start_daemon":
        shell_command = data.get("args", {}).get("command", "")

        if not shell_command:
            return jsonify({"ok": False, "error": "No command provided."}), 400

        if _escapes_workspace(shell_command):
            print(f"[EXEC] REFUSED, leaves the workspace: {shell_command}")
            return jsonify({
                "ok": False,
                "error": f"'{shell_command}' names a path outside the workspace.",
            }), 400

        job_cwd = _resolve_within_workspace(data.get("args", {}).get("cwd", ""))

        if job_cwd is None or not os.path.isdir(job_cwd):
            return jsonify({
                "ok": False,
                "error": f"'{data.get('args', {}).get('cwd')}' is not a project in the workspace.",
            }), 400

        where = os.path.relpath(job_cwd, os.path.abspath(WORKDIR))
        label = shell_command if where == "." else f"{shell_command} (in {where})"

        result = _start_daemon(shell_command, job_cwd, label)

        return jsonify({**result, "cwd": job_cwd})

    # Stops one server by id, or every one still up with all=true. The second
    # form exists because an Alexa session is short and a dev server outlives
    # it: by the time the user says "stop the server" the conversation that
    # started it may be long gone, and refusing on those grounds would be
    # useless to them.
    if command == "stop_daemon":
        args = data.get("args", {})
        job_id = args.get("job_id") or ""
        stop_all = bool(args.get("all"))

        if not job_id and not stop_all:
            return jsonify({"ok": False, "error": "No job_id given, and all was not set."}), 400

        targets = list(_daemons.keys()) if stop_all else [job_id]
        stopped = []
        already = []
        problems = []

        for target in targets:
            proc = _daemons.get(target)

            with _jobs_lock:
                job = _jobs.get(target)
                label = job["command"] if job else target
                log_path = job.get("log") if job else None

            if proc is None:
                if job is None:
                    problems.append(f"Unknown job: {target}")
                else:
                    already.append(target)
                    if log_path:
                        _remove_quietly(log_path)

                continue

            if proc.poll() is not None:
                # Died on its own before anyone asked it to stop.
                _daemons.pop(target, None)
                _finish(target, "done" if proc.returncode == 0 else "failed",
                        returncode=proc.returncode)
                already.append(target)

                if log_path:
                    _remove_quietly(log_path)

                continue

            failure = _kill_tree(proc, label)

            if failure:
                problems.append(f"{label}: {failure}")
                continue

            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                problems.append(f"{label}: still alive after taskkill")
                continue

            _daemons.pop(target, None)
            _finish(target, "stopped", returncode=proc.returncode)
            stopped.append(target)

            # Only once the tree is dead: while any of it is alive Windows keeps
            # a handle on this file and the unlink would fail.
            if log_path:
                _remove_quietly(log_path)

            print(f"[EXEC] {target} stopped: {label}")

        return jsonify({
            "ok": not problems,
            "stopped": stopped,
            "already_stopped": already,
            **({"problems": problems} if problems else {}),
        })

    if command == "list_daemons":
        running = []

        for job_id, proc in list(_daemons.items()):
            # Asking what is running is the moment anything finds out that
            # something is not, so this is where the dead get cleared up.
            if proc.poll() is not None:
                _reap_daemon(job_id, proc)
                continue

            with _jobs_lock:
                job = _jobs.get(job_id)

            running.append({
                "job_id": job_id,
                "command": job["command"] if job else "(unknown)",
                "pid": proc.pid,
                "uptime_seconds": round(time.time() - job["started_at"], 1) if job else None,
            })

        return jsonify({"ok": True, "servers": running})

    # Deliberately instant and read-only: this is what lets the assistant ask
    # "which project?" and act on the answer inside one spoken turn.
    if command == "check_directory":
        folder, path = _project_path(data.get("args", {}).get("project", ""))

        if not folder:
            return jsonify({"ok": False, "error": "No usable project name provided."}), 400

        return jsonify({
            "ok": True,
            "exists": path is not None,
            "project": folder,
            "path": path or os.path.join(WORKDIR, folder),
            "projects": _list_projects()[:20],
        })

    if command == "open_project":
        folder, path = _project_path(data.get("args", {}).get("project", ""))

        if not folder:
            return jsonify({"ok": False, "error": "No usable project name provided."}), 400

        # A missing folder is an ordinary outcome, not a protocol error, so it
        # comes back 200 for the model to handle rather than as an exception.
        if path is None:
            return jsonify({
                "ok": False,
                "exists": False,
                "error": f"There is no '{folder}' in the workspace.",
                "projects": _list_projects()[:20],
            })

        _launch_vscode(path)
        print(f"[EXEC] opened {path}")

        return jsonify({"ok": True, "project": folder, "output": f"Opened {folder} in VS Code."})

    if command == "init_project":
        folder, path = _project_path(data.get("args", {}).get("project", ""))

        if not folder:
            return jsonify({"ok": False, "error": "No usable project name provided."}), 400

        created = path is None

        if created:
            path = os.path.join(WORKDIR, folder)
            os.makedirs(path, exist_ok=True)
            print(f"[EXEC] created {path}")

        try:
            git = subprocess.run(
                ["git", "init"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=30,
                stdin=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            return jsonify({"ok": False, "error": "git is not installed or not on PATH."})
        except subprocess.TimeoutExpired:
            return jsonify({"ok": False, "error": "git init timed out."})

        if git.returncode != 0:
            return jsonify({
                "ok": False,
                "error": (git.stderr.strip() or f"git init exited with {git.returncode}."),
            })

        _launch_vscode(path)

        return jsonify({
            "ok": True,
            "project": folder,
            "created": created,
            "output": f"Created {folder}, initialised a git repo in it and opened it in VS Code."
            if created
            else f"{folder} already existed. Initialised a git repo in it and opened it in VS Code.",
        })

    # No shell anywhere on this path. The prompt goes to the CLI as one argv
    # entry, so $, (), quotes and newlines in it are plain text - there is no
    # shell to interpret them and nothing to escape.
    if command == "start_claude":
        prompt = data.get("args", {}).get("prompt", "")

        if not prompt:
            return jsonify({"ok": False, "error": "No prompt provided."}), 400

        # Where the CLI runs is what decides where the files land, since it
        # acts on its own working directory. Absent means the workspace root,
        # which is where everything went before this was a parameter.
        requested = data.get("args", {}).get("cwd", "")
        job_cwd = _resolve_within_workspace(requested)

        if job_cwd is None:
            return jsonify({"ok": False, "error": f"'{requested}' is outside the workspace."}), 400

        # Deliberately not created here. Making a project directory is
        # init_project's job, and that one is confirmed out loud - having
        # run_claude quietly create it would walk around that.
        if not os.path.isdir(job_cwd):
            return jsonify({
                "ok": False,
                "error": f"There is no '{requested}' in the workspace yet - create the project first.",
                "projects": _list_projects()[:20],
            })

        argv = [CLAUDE_BIN, "-p"]

        if CLAUDE_PERMISSION_MODE:
            argv += ["--permission-mode", CLAUDE_PERMISSION_MODE]

        # The prompt stays last and stays one argument, so nothing in it can be
        # read as a flag.
        argv.append(prompt)

        where = os.path.relpath(job_cwd, os.path.abspath(WORKDIR))
        label = f"claude: {prompt}" if where == "." else f"claude in {where}: {prompt}"

        job_id = _start_job(argv, use_shell=False, label=label, cwd=job_cwd)

        return jsonify({"ok": True, "status": "running", "job_id": job_id, "cwd": job_cwd})

    if command == "job_status":
        job_id = data.get("args", {}).get("job_id", "")

        # A daemon's recorded status is only as fresh as the last time anyone
        # looked, since nothing is waiting on it. Re-read the process before
        # answering, or a server that died an hour ago still reports running.
        daemon = _daemons.get(job_id)

        if daemon is not None and daemon.poll() is not None:
            _reap_daemon(job_id, daemon)

        with _jobs_lock:
            job = _jobs.get(job_id)
            snapshot = dict(job) if job else None

        if snapshot is None:
            return jsonify({"ok": False, "error": f"Unknown job: {job_id}"}), 404

        # Whatever it has printed since, for a server still up.
        if snapshot.get("log"):
            tail = _read_tail(snapshot["log"])

            if tail:
                snapshot["output"] = tail

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
    print(f"[EXEC] vscode : {VSCODE_BIN}")
    print(f"[EXEC] claude permission mode: {CLAUDE_PERMISSION_MODE or '(ask - the CLI will not write files)'}")
    # threaded is the default, but it is the thing that makes job_status
    # answerable while a job is still running, so it is set explicitly.
    app.run(port=int(os.environ.get("EXECUTOR_PORT", "5000")), threaded=True)
