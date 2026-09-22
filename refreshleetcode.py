"""
refresh_leetcode.py
-------------------
Seeds / refreshes the local leetcode.db SQLite database.

Sources:
  1. LeetLog JSONL  — recent problems with full statements (~3138+)
  2. LeetCode public API — metadata (number, slug, title, difficulty)
     for ALL problems, so the app can do live-fetch on demand for older ones

Run:
    python refresh_leetcode.py
"""

import sqlite3
import json
import os
import sys
import time
import requests
from datetime import datetime, timezone

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "leetcode.db")

LEET_LOG_URL   = "https://raw.githubusercontent.com/Leolty/LeetLog/main/problemset.jsonl"
LC_PROBLEMS_URL = "https://leetcode.com/api/problems/all/"


# ── DB setup ────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS problems (
            number       INTEGER PRIMARY KEY,
            title        TEXT    NOT NULL,
            slug         TEXT,
            difficulty   TEXT,
            statement    TEXT,
            hints        TEXT,
            template_py  TEXT,
            link         TEXT,
            updated_at   TEXT
        )
    """)
    conn.commit()
    return conn


def upsert(conn: sqlite3.Connection, row: dict):
    """Insert or update a problem row, preserving existing full statements
    when a metadata-only row is being written."""
    conn.execute("""
        INSERT INTO problems
            (number, title, slug, difficulty, statement, hints, template_py, link, updated_at)
        VALUES
            (:number, :title, :slug, :difficulty, :statement, :hints, :template_py, :link, :updated_at)
        ON CONFLICT(number) DO UPDATE SET
            title       = excluded.title,
            slug        = COALESCE(excluded.slug,        problems.slug),
            difficulty  = COALESCE(excluded.difficulty,  problems.difficulty),
            statement   = COALESCE(excluded.statement,   problems.statement),
            hints       = COALESCE(excluded.hints,       problems.hints),
            template_py = COALESCE(excluded.template_py, problems.template_py),
            link        = COALESCE(excluded.link,        problems.link),
            updated_at  = excluded.updated_at
    """, row)


# ── Source 1: LeetLog JSONL ──────────────────────────────────────────────────

def load_leetlog(conn: sqlite3.Connection) -> int:
    print("[*] Fetching LeetLog problemset.jsonl ...", flush=True)
    try:
        r = requests.get(LEET_LOG_URL, timeout=60)
        r.raise_for_status()
    except requests.RequestException as exc:
        print(f"    [!] Could not fetch LeetLog: {exc}")
        return 0

    lines = [l for l in r.text.strip().split("\n") if l.strip()]
    count = 0
    now   = datetime.now(timezone.utc).isoformat()

    for line in lines:
        try:
            p = json.loads(line)
        except json.JSONDecodeError:
            continue

        num = p.get("number")
        if not num:
            continue

        link = p.get("link", "") or ""
        slug = link.rstrip("/").split("/")[-1] if link else None

        templates = p.get("templates") or {}
        hints_raw = p.get("hints")
        if isinstance(hints_raw, list):
            hints_str = "\n".join(str(h) for h in hints_raw)
        else:
            hints_str = str(hints_raw) if hints_raw else None

        upsert(conn, {
            "number":      num,
            "title":       p.get("title", ""),
            "slug":        slug,
            "difficulty":  (p.get("difficulty") or "").lower(),
            "statement":   p.get("statement", ""),
            "hints":       hints_str,
            "template_py": templates.get("python") or templates.get("python3") or "",
            "link":        link,
            "updated_at":  now,
        })
        count += 1

    conn.commit()
    print(f"    [+] Upserted {count} problems from LeetLog")
    return count


# ── Source 2: LeetCode public problem list (metadata only) ───────────────────

def load_lc_metadata(conn: sqlite3.Connection) -> int:
    print("[*] Fetching LeetCode problem list (metadata) ...", flush=True)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        )
    }
    try:
        r = requests.get(LC_PROBLEMS_URL, headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:
        print(f"    [!] Could not fetch LC metadata: {exc}")
        return 0

    diff_map = {1: "easy", 2: "medium", 3: "hard"}
    pairs    = data.get("stat_status_pairs", [])
    count    = 0
    now      = datetime.now(timezone.utc).isoformat()

    for p in pairs:
        stat = p.get("stat", {})
        num  = stat.get("frontend_question_id")
        if not num:
            continue

        slug = stat.get("question__title_slug", "") or ""
        diff = diff_map.get((p.get("difficulty") or {}).get("level", 0), "")
        link = f"https://leetcode.com/problems/{slug}/" if slug else ""

        # Only write metadata row — don't overwrite any existing full statement
        existing = conn.execute(
            "SELECT statement FROM problems WHERE number=?", (num,)
        ).fetchone()
        stmt_to_write = (existing["statement"] if existing else None)

        upsert(conn, {
            "number":      num,
            "title":       stat.get("question__title", ""),
            "slug":        slug,
            "difficulty":  diff,
            "statement":   stmt_to_write,   # preserve existing, don't stomp
            "hints":       None,
            "template_py": None,
            "link":        link,
            "updated_at":  now,
        })
        count += 1

    conn.commit()
    print(f"    [+] Upserted {count} problems from LeetCode metadata")
    return count


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n[*] Database: {DB_PATH}\n")
    conn = get_db()

    t0 = time.time()
    load_leetlog(conn)
    load_lc_metadata(conn)
    elapsed = time.time() - t0

    total     = conn.execute("SELECT COUNT(*) FROM problems").fetchone()[0]
    with_stmt = conn.execute(
        "SELECT COUNT(*) FROM problems WHERE statement IS NOT NULL AND statement != ''"
    ).fetchone()[0]
    meta_only = total - with_stmt

    conn.close()

    print(f"\n{'='*50}")
    print(f"  Total problems  : {total}")
    print(f"  Full statements : {with_stmt}")
    print(f"  Metadata-only   : {meta_only}  (fetched live on first lookup)")
    print(f"  Time            : {elapsed:.1f}s")
    print(f"{'='*50}\n")
    print("Done. Run 'python app.py' and open the LeetCode tab.\n")
