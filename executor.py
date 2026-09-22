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
        
    return jsonify({"ok": False, "error": f"Unknown command: {command}"}), 400

if __name__ == '__main__':
    app.run(port=5000)
