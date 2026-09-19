import os
import traceback

from flask import Flask, request, jsonify, render_template
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()  # loads variables from a .env file if present

app = Flask(__name__)

API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

client = Anthropic(api_key=API_KEY) if API_KEY else None


def call_model(system_prompt: str, user_prompt: str) -> str:
    """Send a prompt to the LLM and return the text response."""
    if client is None:
        raise RuntimeError(
            "No API key configured. Set ANTHROPIC_API_KEY as an environment "
            "variable (or in a .env file) before starting the server."
        )

    response = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )

    parts = [block.text for block in response.content if block.type == "text"]
    return "\n".join(parts).strip()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/write", methods=["POST"])
def write_code():
    data = request.get_json(force=True) or {}
    description = (data.get("description") or "").strip()
    language = (data.get("language") or "python").strip()

    if not description:
        return jsonify({"error": "Please describe what code you want."}), 400

    system_prompt = (
        f"You are an expert {language} developer. Write clean, correct, "
        f"well-commented {language} code for the user's request. "
        f"Return ONLY the code inside a single fenced code block, followed "
        f"by a short explanation (3-5 lines) of how it works."
    )

    try:
        result = call_model(system_prompt, description)
        return jsonify({"result": result})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/debug", methods=["POST"])
def debug_code():
    data = request.get_json(force=True) or {}
    code = (data.get("code") or "").strip()
    error_message = (data.get("error_message") or "").strip()
    language = (data.get("language") or "python").strip()

    if not code:
        return jsonify({"error": "Please paste the code you want debugged."}), 400

    user_prompt = f"Language: {language}\n\nCode:\n```\n{code}\n```"
    if error_message:
        user_prompt += f"\n\nError / issue observed:\n{error_message}"
    else:
        user_prompt += "\n\nNo explicit error given — review it for bugs, edge cases, and correctness."

    system_prompt = (
        f"You are an expert {language} debugger. Analyze the given code, "
        f"identify the root cause of any bugs, and return the CORRECTED "
        f"full code inside a single fenced code block. After the code, "
        f"list the bugs you found and what you changed, in a short bullet list."
    )

    try:
        result = call_model(system_prompt, user_prompt)
        return jsonify({"result": result})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "api_key_configured": client is not None})


if __name__ == "__main__":
    app.run(debug=True, port=5000)