import os
import subprocess
from flask import Flask, request, jsonify

app = Flask(__name__)

SECRET = os.environ.get("EXECUTOR_SECRET", "jarvis_secret_123")

@app.route('/execute', methods=['POST'])
def execute():
    if request.headers.get('X-Executor-Secret') != SECRET:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.json
    command = data.get("command")
    
    if command == "open_vscode":
        subprocess.run("code .", shell=True) 
        return jsonify({"ok": True, "output": "VS Code launched successfully."})

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
            )
        except subprocess.TimeoutExpired:
            print(f"[EXEC] timed out after 15s: {shell_command}")
            return jsonify({"ok": False, "error": f"'{shell_command}' timed out after 15 seconds."}), 400

        output = result.stdout.strip() or result.stderr.strip() or "(no output)"
        print(f"[EXEC] rc={result.returncode}, {len(output)} chars returned")

        return jsonify({"ok": True, "output": output})
        
    return jsonify({"ok": False, "error": f"Unknown command: {command}"}), 400

if __name__ == '__main__':
    app.run(port=5000)
