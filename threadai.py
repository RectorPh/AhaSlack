"""Local AI for threads: decides whether a message sent WITHOUT Telegram's Reply continues one of
the threads open just before it, using a small model on this Mac through Ollama. Nothing leaves
the computer. Answers are cached in inbox.db (each message is judged once) and sent to the page as
`thread_hint` (a thread's first-message id, or 0 for "not part of a thread").

Settings come from the app's preferences (uiPrefs.threadAi = {"enabled": true, "model": "qwen2.5:3b"}).
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import urllib.request

OLLAMA = "http://127.0.0.1:11434"
DEFAULT_MODEL = "qwen2.5:3b"
WINDOW_S = 15 * 60       # a thread counts as "open" if it had a message in the last 15 minutes
MAX_THREADS = 3          # how many open threads the model chooses between
MAX_PER_WINDOW = 40      # judge at most this many messages per chat load

SYSTEM = (
    "You sort messages in a work group chat (Vietnamese and English) into Slack-style threads. "
    "On Telegram people often answer without pressing Reply, so a message can continue a thread "
    "even without a reply link. Decide whether the NEW message continues one of the numbered open "
    "threads (answers its question, follows up on its topic, reacts to its last message), or is "
    "a separate message to the whole group (a new topic, an announcement, small talk, a question "
    "to everyone). If unsure, choose 0. Reply with JSON only: {\"thread\": <number or 0>}."
)


def _post(path: str, body: dict, timeout: float = 60) -> dict:
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _get(path: str, timeout: float = 3) -> dict:
    with urllib.request.urlopen(OLLAMA + path, timeout=timeout) as r:
        return json.loads(r.read())


async def status(model: str) -> dict:
    """Is Ollama running, and is the model downloaded?"""
    try:
        tags = await asyncio.to_thread(_get, "/api/tags")
    except Exception:  # noqa: BLE001 - not installed or not running
        return {"running": False, "models": [], "has_model": False}
    names = [m.get("name", "") for m in tags.get("models", [])]
    want = model if ":" in model else model + ":latest"
    return {"running": True, "models": names, "has_model": want in names or model in names}


PULL = {"model": None, "status": "", "done": False, "error": None, "pct": 0}


async def pull(model: str) -> None:
    """Download the model through Ollama (only when you click the button)."""
    PULL.update(model=model, status="starting", done=False, error=None, pct=0)

    def run():
        req = urllib.request.Request(OLLAMA + "/api/pull", data=json.dumps({"model": model, "stream": True}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3600) as r:
            for line in r:
                ev = json.loads(line or b"{}")
                if ev.get("error"):
                    raise RuntimeError(ev["error"])
                PULL["status"] = ev.get("status", "")
                if ev.get("total"):
                    PULL["pct"] = round(100 * (ev.get("completed") or 0) / ev["total"])
    try:
        await asyncio.to_thread(run)
        PULL.update(done=True, status="ready", pct=100)
    except Exception as exc:  # noqa: BLE001
        PULL.update(done=True, error=str(exc))


# ---------------------------------------------------------------- which messages to judge
def threads_in(msgs: list[dict]) -> dict[int, int]:
    """Telegram's own reply chains in this window: message id -> thread root id."""
    by_id = {m["id"]: m for m in msgs}
    root: dict[int, int] = {}

    def resolve(m, depth=0):
        if m["id"] in root:
            return root[m["id"]]
        r = None
        if m.get("reply_to"):
            p = by_id.get(m["reply_to"])
            r = (resolve(p, depth + 1) or p["id"]) if p and depth < 60 else (m.get("thread_top") or m["reply_to"])
        if r is not None and r != m["id"]:
            root[m["id"]] = r
        return root.get(m["id"])
    for m in msgs:
        resolve(m)
    return root


def _line(m: dict, limit: int = 220) -> str:
    who = "Me" if m.get("out") else (m.get("sender") or {}).get("name") or "?"
    text = (m.get("text") or "").replace("\n", " ").strip() or f"[{m.get('media') or 'message'}]"
    return f'{who}: "{text[:limit]}"'


def candidates(msgs: list[dict], known: dict[int, int]) -> list[tuple[dict, list[tuple[int, list[dict]]], list[dict]]]:
    """Messages without Reply that come while threads are open: (message, open threads, channel context)."""
    msgs = sorted(msgs, key=lambda m: m["id"])
    root = threads_in(msgs)
    by_id = {m["id"]: m for m in msgs}
    out = []
    for i, m in enumerate(msgs):
        if m.get("reply_to") or m["id"] in known or m["id"] in root:
            continue
        if not (m.get("text") or m.get("media")):
            continue
        t = m.get("ts") or 0
        open_threads: dict[int, list[dict]] = {}
        last_seen: dict[int, float] = {}
        for x in msgs[:i]:
            r = root.get(x["id"])
            if r is None or t - (x.get("ts") or 0) > WINDOW_S:
                continue
            open_threads.setdefault(r, []).append(x)
            last_seen[r] = x.get("ts") or 0
        if not open_threads:
            continue
        ranked = sorted(open_threads, key=lambda r: -last_seen[r])[:MAX_THREADS]
        threads = [(r, [by_id[r]] + open_threads[r][-3:] if r in by_id else open_threads[r][-4:]) for r in ranked]
        channel = [x for x in msgs[max(0, i - 3):i] if x["id"] not in root and x["id"] not in open_threads][-2:]
        out.append((m, threads, channel))
    return out


def _prompt(m: dict, threads, channel) -> str:
    parts = []
    for n, (r, items) in enumerate(threads, 1):
        parts.append(f"Thread {n}:\n" + "\n".join("  " + _line(x) for x in items))
    if channel:
        parts.append("Just before, in the channel (not in a thread):\n" + "\n".join("  " + _line(x) for x in channel))
    parts.append(f"NEW message from {_line(m, 400)}\nWhich thread does the NEW message continue? 0 if none.")
    return "\n\n".join(parts)


async def judge(model: str, m: dict, threads, channel) -> int:
    """The thread root the message continues, or 0."""
    body = {"model": model, "stream": False, "format": "json", "keep_alive": "30m",
            "options": {"temperature": 0, "num_predict": 16},
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(m, threads, channel)}]}
    res = await asyncio.to_thread(_post, "/api/chat", body)
    text = (res.get("message") or {}).get("content", "")
    try:
        n = int(json.loads(text).get("thread", 0))
    except Exception:  # noqa: BLE001 - the model wrote something else
        mt = re.search(r"\d+", text)
        n = int(mt.group()) if mt else 0
    return threads[n - 1][0] if 1 <= n <= len(threads) else 0


async def judge_window(db, chat_id: int, msgs: list[dict], model: str, publish) -> int:
    """Judge the open-thread messages of a chat window that aren't cached yet; push answers live."""
    known = db.thread_hints(chat_id, [m["id"] for m in msgs])
    todo = candidates(msgs, known)[-MAX_PER_WINDOW:]
    done: dict[int, int] = {}
    for m, threads, channel in todo:
        try:
            r = await judge(model, m, threads, channel)
        except Exception as exc:  # noqa: BLE001 - Ollama stopped, model missing...
            print(f"thread AI: {exc}", file=sys.stderr)
            break
        db.set_thread_hint(chat_id, m["id"], r, model)
        done[m["id"]] = r
        if len(done) % 5 == 0:
            publish({"type": "thread_hints", "chat_id": chat_id, "hints": {str(k): v for k, v in done.items()}})
    if done:
        publish({"type": "thread_hints", "chat_id": chat_id, "hints": {str(k): v for k, v in done.items()}})
    return len(done)
