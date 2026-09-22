import os
import sqlite3
import time
import traceback
import subprocess
import sys
import re
import json
from flask import Flask, request, jsonify, render_template
import httpx
from dotenv import load_dotenv

# Explicitly load .env from the same folder as app.py
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(dotenv_path=env_path, override=True)

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")

# Path to the LeetCode SQLite database (created by refresh_leetcode.py)
LC_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leetcode.db")


def get_gemini_config():
    """Get sanitized GEMINI_API_KEY and GEMINI_MODEL."""
    api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("API_KEY") or "").strip().strip('"\'')
    model = (os.environ.get("GEMINI_MODEL") or "gemini-1.5-flash").strip().strip('"\'')

    if not api_key:
        raise RuntimeError(
            f"No Gemini API key found. Checked {env_path}. "
            "Please ensure GEMINI_API_KEY is set in your .env file."
        )
    return api_key, model


def call_model(system_prompt: str, user_prompt: str, image_data: dict = None) -> str:
    """Send a prompt (and optional image) to Google Gemini API with auto-retry and return the text response."""
    api_key, primary_model = get_gemini_config()

    parts = []
    if user_prompt:
        parts.append({"text": user_prompt})

    # Add inline image if provided
    if image_data and image_data.get("data"):
        mime_type = image_data.get("mime_type") or "image/jpeg"
        raw_data = image_data["data"]
        if "," in raw_data:
            raw_data = raw_data.split(",", 1)[1]
        parts.append({
            "inline_data": {
                "mime_type": mime_type,
                "data": raw_data
            }
        })

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": parts
            }
        ]
    }

    if system_prompt:
        payload["system_instruction"] = {
            "parts": [{"text": system_prompt}]
        }

    # Candidate models to try in case of 503 high demand
    models_to_try = [primary_model]
    for fallback in ["gemini-2.5-flash", "gemini-1.5-flash"]:
        if fallback not in models_to_try:
            models_to_try.append(fallback)

    last_err = None
    for model_name in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        }

        # Try up to 2 attempts per model
        for attempt in range(2):
            try:
                response = httpx.post(url, headers=headers, json=payload, timeout=60.0)
                if response.status_code == 200:
                    data = response.json()
                    candidates = data.get("candidates", [])
                    if not candidates:
                        raise RuntimeError("Gemini returned no candidates (the response may have been filtered).")
                    p_parts = candidates[0].get("content", {}).get("parts", [])
                    text_pieces = [p.get("text", "") for p in p_parts if "text" in p]
                    return "\n".join(text_pieces).strip()

                # Handle 503 (high demand) or 429 (rate limit) with retry
                if response.status_code in (503, 429):
                    try:
                        err_msg = response.json().get("error", {}).get("message", response.text)
                    except Exception:
                        err_msg = response.text
                    last_err = f"Gemini API Error ({response.status_code}) on {model_name}: {err_msg}"
                    time.sleep(1.5)
                    continue
                else:
                    try:
                        err_msg = response.json().get("error", {}).get("message", response.text)
                    except Exception:
                        err_msg = response.text
                    raise RuntimeError(f"Gemini API Error ({response.status_code}): {err_msg}")
            except httpx.RequestError as req_err:
                last_err = str(req_err)
                time.sleep(1.0)
                continue

    raise RuntimeError(last_err or "Gemini API request failed across all model attempts.")


@app.route("/")
def index():
    return render_template("index.html")


# Shared formatting rule injected into every system prompt that produces code.
FORMAT_RULE = (
    "\n\n"
    "STRICT OUTPUT FORMAT — follow this every time:\n"
    "1. Output exactly ONE fenced code block containing the complete code, "
    "using the correct language identifier (e.g. ```python, ```java, ```javascript).\n"
    "2. Do NOT nest fences, duplicate fences, or add any extra ``` before or after "
    "the single code block.\n"
    "3. Immediately after the code block, add a plain-text / markdown explanation "
    "section with the heading 'Explanation:' followed by bullet points describing "
    "the key parts of the code.\n"
    "4. Never place explanation text inside the code fence, and never place code "
    "outside the fence.\n"
    "5. Code first, explanation second — no exceptions.\n"
    "6. If no code is involved in the answer, respond normally without any code fence."
)


@app.route("/api/write", methods=["POST"])
def write_code():
    data = request.get_json(force=True) or {}
    description = (data.get("description") or "").strip()
    language = (data.get("language") or "python").strip()
    image_data = data.get("image_data")

    has_image = bool(image_data and image_data.get("data"))

    if not description and not has_image:
        return jsonify({"error": "Please describe what code you want or upload a photo."}), 400

    prompt_parts = []
    if description:
        prompt_parts.append(f"Description / Notes:\n{description}")
    if has_image:
        prompt_parts.append(
            "Note: The user attached an image (e.g. pseudocode, handwritten notes, "
            "architecture diagram, or problem specification). Inspect the image carefully "
            "to understand and produce the required code."
        )

    user_prompt = "\n\n".join(prompt_parts)

    system_prompt = (
        f"You are an expert {language} developer embedded in a coding assistant web app. "
        f"Write clean, correct, well-commented {language} code for the user's request "
        f"and any attached image."
        + FORMAT_RULE
    )

    try:
        result = call_model(system_prompt, user_prompt, image_data=image_data)
        return jsonify({"result": result})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/debug", methods=["POST"])
def debug_code():
    data = request.get_json(force=True) or {}
    code = (data.get("code") or "").strip()
    error_message = (data.get("error_message") or "").strip()
    language = (data.get("language") or "auto").strip()
    image_data = data.get("image_data")

    has_image = bool(image_data and image_data.get("data"))

    if not code and not has_image:
        return jsonify({"error": "Please paste the code or upload a photo of the code to debug."}), 400

    prompt_parts = []
    if code:
        prompt_parts.append(f"Code:\n```\n{code}\n```")
    if has_image:
        prompt_parts.append("Note: The user has attached a photo/screenshot containing code and/or error output. Inspect the image carefully to extract the code and identify issues.")
    if error_message:
        prompt_parts.append(f"Error / issue observed:\n{error_message}")
    else:
        prompt_parts.append("No explicit error given — review it for bugs, edge cases, and correctness.")

    user_prompt = "\n\n".join(prompt_parts)

    if language.lower() in ("", "auto"):
        system_prompt = (
            "You are an expert multi-language debugger embedded in a coding assistant web app. "
            "Analyze the given code (text and/or image) and its keywords/syntax to automatically "
            "identify the programming language. Identify the root cause of any bugs and return "
            "the corrected code. After the code block, state the detected language, list every "
            "bug found, and explain what was changed — use bullet points."
            + FORMAT_RULE
        )
    else:
        system_prompt = (
            f"You are an expert {language} debugger embedded in a coding assistant web app. "
            f"Analyze the given code (text and/or image), identify the root cause of any bugs, "
            f"and return the corrected code. After the code block, list every bug found and what "
            f"was changed — use bullet points."
            + FORMAT_RULE
        )

    try:
        result = call_model(system_prompt, user_prompt, image_data=image_data)
        return jsonify({"result": result})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/explain", methods=["POST"])
def explain_topic():
    data = request.get_json(force=True) or {}
    topic    = (data.get("topic")    or "").strip()
    depth    = (data.get("depth")    or "overview").strip()
    language = (data.get("language") or "python").strip()

    if not topic:
        return jsonify({"error": "Please provide a topic to explain."}), 400

    if depth == "deep":
        system_prompt = (
            "You are an expert CS educator embedded in a coding assistant web app, writing "
            "deep technical notes for a student who wants complete mastery of this topic. "
            "For the given algorithm or data structure, provide ALL of the following in order:\n"
            "1. Intuition and motivation — why does this exist, what problem does it solve?\n"
            "2. Step-by-step explanation with a concrete worked example (trace each step).\n"
            "3. A clean, well-commented implementation in the requested language.\n"
            "4. Time complexity analysis for best / average / worst case — with proof or "
            "reasoning, not just the Big-O.\n"
            "5. Space complexity analysis.\n"
            "6. Edge cases and common pitfalls.\n"
            "7. Real-world use cases and when NOT to use this.\n"
            "8. Comparison with 1-2 alternative approaches and their trade-offs."
            + FORMAT_RULE
        )
    else:
        system_prompt = (
            "You are an expert CS educator embedded in a coding assistant web app, giving "
            "a concise but clear overview of an algorithm or data structure. Provide:\n"
            "1. A one-paragraph plain-English explanation of how it works.\n"
            "2. A short, clean implementation in the requested language.\n"
            "3. Time and space complexity (Big-O only, brief).\n"
            "4. One or two key use cases.\n"
            "Keep it tight — the student wants a fast, accurate mental model, not a textbook chapter."
            + FORMAT_RULE
        )

    user_prompt = (
        f"Topic: {topic}\n"
        f"Code examples should be in: {language}\n"
        f"Depth: {'Deep dive with full complexity proofs' if depth == 'deep' else 'Quick overview'}"
    )

    try:
        result = call_model(system_prompt, user_prompt)
        return jsonify({"result": result})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500



# ── LeetCode helpers ──────────────────────────────────────────────────────────

def _lc_db():
    """Open the LeetCode SQLite DB, or return None if it doesn't exist yet."""
    if not os.path.exists(LC_DB_PATH):
        return None
    conn = sqlite3.connect(LC_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _fetch_problem_live(slug: str) -> dict | None:
    """
    Live-fetch a problem's full statement from the alfa-leetcode-api.
    Used as a fallback for problems whose statement isn't in the local DB yet.
    """
    try:
        url  = f"https://alfa-leetcode-api.onrender.com/select?titleSlug={slug}"
        resp = httpx.get(url, timeout=20.0)
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None


@app.route("/api/leetcode/<int:number>", methods=["GET"])
def get_leetcode_problem(number):
    """Pure DB lookup — no LLM call. Falls back to a live fetch if needed."""
    conn = _lc_db()
    if conn is None:
        return jsonify({
            "error": (
                "LeetCode database not found. "
                "Run  python refresh_leetcode.py  first to seed it."
            )
        }), 503

    row = conn.execute("SELECT * FROM problems WHERE number=?", (number,)).fetchone()
    conn.close()

    if not row:
        return jsonify({
            "error": (
                f"Problem #{number} not found in the local database. "
                "Run  python refresh_leetcode.py  to refresh, "
                "or check that the number is correct."
            )
        }), 404

    prob = dict(row)

    # If we have metadata (slug) but no full statement, try a live fetch and cache it
    if not (prob.get("statement") or "").strip() and (prob.get("slug") or "").strip():
        live = _fetch_problem_live(prob["slug"])
        if live:
            stmt       = live.get("question", "") or ""
            tpl        = live.get("pythonDefaultCode", "") or ""
            hints_list = live.get("hints") or []
            hints_str  = "\n".join(str(h) for h in hints_list)

            # Cache in DB so we never need to live-fetch this one again
            try:
                c2 = sqlite3.connect(LC_DB_PATH)
                c2.execute(
                    "UPDATE problems SET statement=?, template_py=?, hints=? WHERE number=?",
                    (stmt, tpl, hints_str, number)
                )
                c2.commit()
                c2.close()
            except Exception:
                pass

            prob["statement"]   = stmt
            prob["template_py"] = prob.get("template_py") or tpl
            prob["hints"]       = prob.get("hints") or hints_str

    if not (prob.get("statement") or "").strip():
        return jsonify({
            "error": (
                f"Problem #{number} is in the database but its full statement "
                "isn't available locally yet. "
                "Run  python refresh_leetcode.py  or try again in a moment."
            )
        }), 404

    return jsonify({
        "number":      prob["number"],
        "title":       prob["title"]      or "",
        "difficulty":  prob["difficulty"] or "",
        "statement":   prob["statement"]  or "",
        "hints":       prob["hints"]      or "",
        "template_py": prob["template_py"] or "",
        "link":        prob["link"]       or "",
    })


@app.route("/api/leetcode/review", methods=["POST"])
def leetcode_review():
    """Send the student's approach to Gemini for a coaching nudge."""
    data      = request.get_json(force=True) or {}
    number    = data.get("number")
    title     = (data.get("title")     or "").strip()
    statement = (data.get("statement") or "").strip()
    approach  = (data.get("approach")  or "").strip()

    if not approach:
        return jsonify({"error": "Please describe your approach first."}), 400
    if not title or not statement:
        return jsonify({"error": "Problem data missing — fetch the problem first."}), 400

    system_prompt = (
        "You are an expert LeetCode coach embedded in an interview preparation app. "
        "The student has submitted their proposed approach for a specific LeetCode problem.\n\n"
        "CRITICAL FORMATTING REQUIREMENT:\n"
        "You MUST structure your response using markdown H3 headings ('### ') for EVERY section listed below. "
        "Do NOT group sections into bullet lists with bold titles (like '- **Correctness:**'). "
        "Output each as a distinct '### ' heading:\n\n"
        "### 🎯 Problem Under Review\n"
        f"**Problem #{number}: {title}**\n\n"
        "### ⭐ Approach Rating\n"
        "**Score: [X] / 10**\n"
        "(Explain the score in 1-2 sentences: evaluate correctness, and especially how the Time Complexity "
        "and Space Complexity compare to the optimal solution accepted by the majority of successful LeetCode submissions).\n\n"
        "### ⏱ Complexity Comparison\n"
        "- **Your Approach:** Time: `O(...)` | Space: `O(...)`\n"
        "- **Standard Optimal LeetCode Approach:** Time: `O(...)` | Space: `O(...)` (what most accepted submissions use)\n\n"
        "### 🔍 Correctness & Test Case Analysis\n"
        "(State if the approach will pass all test cases or if it will fail / get TLE (Time Limit Exceeded) on large constraints. Mention why).\n\n"
        "### 💡 What Most LeetCode Users Do\n"
        "(Explain the standard optimal data structure or pattern like HashMap, Two Pointers, Sliding Window, DP, or Monotonic Stack that most top LeetCode users employ).\n\n"
        "### ⚠️ Key Bottleneck & Edge Cases\n"
        "(Point out the exact bottleneck, redundant iteration, or unhandled edge cases like duplicates, empty arrays, or negative values).\n\n"
        "### 🚀 Guiding Nudge\n"
        "(Give a guiding question or hint to steer them to the 10/10 optimal solution without revealing the complete code).\n\n"
        "RULES:\n"
        "- Do NOT provide the complete solution code unless the student explicitly wrote 'give me the solution', 'show me the code', or 'I give up'.\n"
        "- Always output proper markdown H3 ('### ') headings for each section."
    )

    # Truncate very long statements to avoid token waste
    stmt_excerpt = statement[:3000] + ("…" if len(statement) > 3000 else "")

    user_prompt = (
        f"Problem #{number}: {title}\n\n"
        f"Problem Statement:\n{stmt_excerpt}\n\n"
        f"Student's Approach:\n{approach}"
    )

    try:
        result = call_model(system_prompt, user_prompt)
        return jsonify({"result": result})
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


# ── Python Test Runner (Code Execution against Test Cases) ───────────────────

def extract_test_cases(statement: str):
    """
    Extract test cases (input strings and expected outputs) from problem statement.
    Supports both HTML (<pre><strong>Input:</strong> ...</pre>) and Markdown (**Input:** ...).
    """
    if not statement:
        return []

    clean = re.sub(r'<[^>]+>', ' ', statement)
    clean = clean.replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')

    pattern = re.compile(
        r'Input:\s*(.*?)\s*Output:\s*(.*?)(?=(?:Explanation:|Example|\n\s*\n\s*\n|Constraints:|$))',
        re.DOTALL | re.IGNORECASE
    )
    matches = pattern.findall(clean)
    cases = []
    for i, (inp, out) in enumerate(matches, 1):
        inp_clean = inp.strip()
        out_clean = out.strip()
        if '\n' in inp_clean:
            inp_clean = ", ".join([l.strip() for l in inp_clean.split('\n') if l.strip()])
        if '\n' in out_clean:
            out_clean = out_clean.split('\n')[0].strip()

        if inp_clean and out_clean:
            cases.append({
                "id": i,
                "input": inp_clean,
                "expected": out_clean
            })
    return cases


@app.route("/api/leetcode/run", methods=["POST"])
def leetcode_run():
    """
    Executes Python code against problem test cases in a sandboxed subprocess
    with a hard 4.0s timeout to protect against infinite loops.
    """
    data = request.get_json(force=True) or {}
    code = (data.get("code") or "").strip()
    number = data.get("number") or data.get("problem_number")
    custom_cases = data.get("test_cases")

    if not code:
        return jsonify({"error": "Please provide Python code to run."}), 400

    # Retrieve test cases: use custom cases or extract from problem in DB
    cases = []
    if custom_cases and isinstance(custom_cases, list) and len(custom_cases) > 0:
        cases = custom_cases
    elif number:
        conn = _lc_db()
        if conn:
            row = conn.execute("SELECT statement FROM problems WHERE number=?", (number,)).fetchone()
            conn.close()
            if row and row["statement"]:
                cases = extract_test_cases(row["statement"])

    # Fallback default test case if none could be parsed
    if not cases:
        cases = [{"id": 1, "input": "", "expected": ""}]

    # Harness script executed in isolated Python subprocess
    harness_script = f"""
import sys
import json
import time
import inspect
from typing import *

# --- User Code ---
{code}

# --- Test Runner Harness ---
test_cases = {json.dumps(cases)}
results = []

def run_suite():
    sol_instance = None
    target_func = None

    if 'Solution' in globals() and isinstance(globals()['Solution'], type):
        try:
            sol_instance = globals()['Solution']()
            for attr in dir(sol_instance):
                if not attr.startswith('_') and callable(getattr(sol_instance, attr)):
                    target_func = getattr(sol_instance, attr)
                    break
        except Exception as e:
            pass

    if not target_func:
        for name, val in list(globals().items()):
            if callable(val) and not name.startswith('_') and name not in ('run_suite', 'List', 'Dict', 'Tuple', 'Set', 'Optional', 'Union', 'Any'):
                target_func = val
                break

    for tc in test_cases:
        tc_id = tc.get("id", 1)
        raw_input = tc.get("input", "").strip()
        raw_expected = tc.get("expected", "").strip()

        local_vars = {{}}
        if raw_input:
            input_parts = []
            for part in raw_input.split(', '):
                if '=' in part:
                    input_parts.append(part)
                elif input_parts:
                    input_parts[-1] += ', ' + part
                else:
                    input_parts.append(part)
            exec_code = "\\n".join(input_parts)
            try:
                exec(exec_code, globals(), local_vars)
            except Exception:
                pass

        t0 = time.perf_counter()
        try:
            if target_func:
                sig = inspect.signature(target_func)
                call_kwargs = {{}}
                for param_name in sig.parameters.keys():
                    if param_name in local_vars:
                        call_kwargs[param_name] = local_vars[param_name]

                if len(call_kwargs) == len(sig.parameters) and len(call_kwargs) > 0:
                    actual = target_func(**call_kwargs)
                elif local_vars:
                    actual = target_func(*list(local_vars.values()))
                else:
                    actual = target_func()
            else:
                raise RuntimeError("No function or Solution method found to test.")

            elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

            # Compare actual with expected
            try:
                parsed_expected = eval(raw_expected)
            except Exception:
                parsed_expected = raw_expected

            passed = False
            if raw_expected:
                passed = (actual == parsed_expected) or (str(actual) == str(raw_expected)) or (repr(actual) == str(raw_expected))
            else:
                passed = True

            results.append({{
                "id": tc_id,
                "input": raw_input,
                "expected": raw_expected,
                "actual": repr(actual) if actual is not None else "None",
                "passed": bool(passed),
                "runtime_ms": elapsed_ms,
                "error": None
            }})
        except Exception as exc:
            elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)
            results.append({{
                "id": tc_id,
                "input": raw_input,
                "expected": raw_expected,
                "actual": None,
                "passed": False,
                "runtime_ms": elapsed_ms,
                "error": f"{{type(exc).__name__}}: {{str(exc)}}"
            }})

    print("___RUNNER_JSON___" + json.dumps(results) + "___RUNNER_END___")

try:
    run_suite()
except Exception as suite_err:
    print("___RUNNER_ERROR___" + str(suite_err) + "___RUNNER_END___")
"""

    try:
        proc = subprocess.run(
            [sys.executable, "-c", harness_script],
            capture_output=True,
            text=True,
            timeout=4.0
        )
    except subprocess.TimeoutExpired:
        return jsonify({
            "success": False,
            "error": "Time Limit Exceeded: Execution timed out after 4.0 seconds. Check for infinite loops.",
            "test_cases": []
        }), 200

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""

    if "___RUNNER_JSON___" in stdout:
        json_part = stdout.split("___RUNNER_JSON___")[1].split("___RUNNER_END___")[0]
        try:
            results = json.loads(json_part)
            total = len(results)
            passed_count = sum(1 for r in results if r.get("passed"))
            return jsonify({
                "success": True,
                "all_passed": (total > 0 and passed_count == total),
                "passed_count": passed_count,
                "total_count": total,
                "summary": f"{passed_count} / {total} Test Cases Passed",
                "test_cases": results,
                "stdout": stdout.split("___RUNNER_JSON___")[0].strip()
            })
        except Exception as parse_err:
            return jsonify({"success": False, "error": f"Failed to parse test results: {parse_err}"}), 500

    if proc.returncode != 0:
        error_lines = [l for l in stderr.strip().split("\n") if l.strip()]
        error_msg = error_lines[-1] if error_lines else "Unknown execution error"
        return jsonify({
            "success": False,
            "error": f"Execution Error: {error_msg}",
            "details": stderr.strip()
        }), 200

    return jsonify({
        "success": True,
        "all_passed": True,
        "summary": "Executed successfully",
        "test_cases": [],
        "stdout": stdout.strip()
    })



@app.route("/api/health")
def health():
    try:
        _, model = get_gemini_config()
        return jsonify({"ok": True, "api_key_configured": True, "provider": "Google Gemini", "model": model})
    except Exception as exc:
        return jsonify({"ok": True, "api_key_configured": False, "provider": "Google Gemini", "error": str(exc)})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
