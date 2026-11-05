"""AhaSlack's own database (SQLite) for Activity: every @mention of you and every reply to you,
kept for good, with Slack-style read state.

A mention is "read" once you've seen it in the app (or read it in Telegram). The unread count
on the badge and the Activity list both come from here, so they always agree.
File: ~/.config/telegram-inbox/inbox.db (owner-only).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS mentions (
    key      TEXT PRIMARY KEY,            -- "chat_id:msg_id"
    chat_id  INTEGER NOT NULL,
    msg_id   INTEGER NOT NULL,
    topic_id INTEGER,
    kind     TEXT NOT NULL,               -- "mention" | "reply"
    ts       REAL NOT NULL,               -- when it was sent (unix seconds)
    read     INTEGER NOT NULL DEFAULT 0,  -- 1 once seen in the app or read in Telegram
    read_at  REAL,
    first_seen REAL NOT NULL,
    data     TEXT NOT NULL                -- the full message as the page shows it (JSON)
);
CREATE INDEX IF NOT EXISTS mentions_ts ON mentions(ts DESC);
CREATE INDEX IF NOT EXISTS mentions_unread ON mentions(read, ts DESC);
CREATE INDEX IF NOT EXISTS mentions_chat ON mentions(chat_id, msg_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- Threads you're in (Slack's Threads view): you replied in it, or someone replied to you.
CREATE TABLE IF NOT EXISTS threads (
    key      TEXT PRIMARY KEY,            -- "chat_id:root_id"
    chat_id  INTEGER NOT NULL,
    root_id  INTEGER NOT NULL,
    topic_id INTEGER,
    root     TEXT,                        -- the root message (JSON), filled in lazily
    last     TEXT,                        -- the latest reply (JSON)
    last_ts  REAL NOT NULL,
    replies  INTEGER NOT NULL DEFAULT 0,  -- replies seen by the app
    unread   INTEGER NOT NULL DEFAULT 0,  -- new replies since you last opened it
    mine     INTEGER NOT NULL DEFAULT 0   -- you replied in it
);
CREATE INDEX IF NOT EXISTS threads_last ON threads(last_ts DESC);
-- Which thread a message belongs to (to follow reply-to-a-reply chains).
-- Where you go and what you write (for Slack-style "frecency" ranking in search and ⌘K).
CREATE TABLE IF NOT EXISTS visits (chat_id INTEGER NOT NULL, ts REAL NOT NULL, kind TEXT NOT NULL, q TEXT);
CREATE INDEX IF NOT EXISTS visits_chat ON visits(chat_id, ts DESC);
-- Your ✓/✗ verdicts on thread grouping decisions (the accuracy check), kept as training data.
CREATE TABLE IF NOT EXISTS thread_labels (
    key TEXT PRIMARY KEY,                 -- "chat_id:msg_id:kind"
    chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                   -- reply | split | burst | answer | revive | missed
    root_id INTEGER, verdict INTEGER NOT NULL,  -- 1 = the rule was right, 0 = wrong
    rules TEXT, ts REAL NOT NULL, data TEXT
);
CREATE TABLE IF NOT EXISTS thread_msgs (chat_id INTEGER, msg_id INTEGER, root_id INTEGER, PRIMARY KEY(chat_id, msg_id));
"""
DROP = ("done", "flags")  # per-request fields that shouldn't be stored


class MentionDB:
    def __init__(self, path: Path):
        new = not path.exists()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        if new:
            os.chmod(path, 0o600)

    # ------------------------------------------------------------- meta
    def get_meta(self, k: str, default=None):
        row = self.conn.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
        return json.loads(row["v"]) if row else default

    def set_meta(self, k: str, v) -> None:
        with self.conn:
            self.conn.execute("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, json.dumps(v)))

    # ------------------------------------------------------------- writes
    def upsert(self, items: list[dict], read_keys: set[str] = frozenset()) -> int:
        """Add or refresh mentions. Read state only ever moves to read here: once you've seen
        a mention it stays read, and Telegram saying it's read marks it read too."""
        now = time.time()
        before = self.count()
        with self.conn:
            for m in items:
                data = {k: v for k, v in m.items() if k not in DROP}
                read = 1 if (not m.get("unread", True) or m["key"] in read_keys) else 0
                self.conn.execute(
                    """INSERT INTO mentions(key, chat_id, msg_id, topic_id, kind, ts, read, read_at, first_seen, data)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(key) DO UPDATE SET data = excluded.data, topic_id = excluded.topic_id,
                         read = MAX(mentions.read, excluded.read),
                         read_at = COALESCE(mentions.read_at, excluded.read_at)""",
                    (m["key"], m["chat"]["id"], m["id"], m.get("topic_id"), m.get("kind", "mention"), m["ts"],
                     read, now if read else None, now, json.dumps(data, ensure_ascii=False, default=str)))
        return self.count() - before

    def mark(self, keys: list[str], read: bool = True) -> int:
        with self.conn:
            cur = self.conn.executemany(
                "UPDATE mentions SET read = ?, read_at = ? WHERE key = ?",
                [(1 if read else 0, time.time() if read else None, k) for k in keys])
        return cur.rowcount

    def mark_chat_read(self, chat_id: int, upto_msg_id: int, topic_id: int | None = None) -> list[str]:
        """You read a chat (or one topic) up to a message: its mentions up to there are read."""
        q = "SELECT key FROM mentions WHERE read = 0 AND chat_id = ? AND msg_id <= ?"
        args: list = [chat_id, upto_msg_id]
        if topic_id is not None:
            q += " AND topic_id = ?"
            args.append(topic_id)
        keys = [r["key"] for r in self.conn.execute(q, args)]
        self.mark(keys)
        return keys

    def mark_all_read(self, exclude_chats: set[int] = frozenset()) -> list[dict]:
        rows = [r for r in self.conn.execute("SELECT key, chat_id, msg_id FROM mentions WHERE read = 0") if r["chat_id"] not in exclude_chats]
        self.mark([r["key"] for r in rows])
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- reads
    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM mentions").fetchone()[0]

    def unread_count(self, exclude_chats: set[int] = frozenset()) -> int:
        rows = self.conn.execute("SELECT chat_id, COUNT(*) n FROM mentions WHERE read = 0 GROUP BY chat_id")
        return sum(r["n"] for r in rows if r["chat_id"] not in exclude_chats)

    def unread_keys(self, keys: list[str]) -> list[dict]:
        if not keys:
            return []
        marks = ",".join("?" * len(keys))
        return [dict(r) for r in self.conn.execute(f"SELECT key, chat_id, msg_id FROM mentions WHERE read = 0 AND key IN ({marks})", keys)]

    def list(self, *, filter: str = "all", limit: int = 100, before: float | None = None,
             since: float | None = None, exclude_chats: set[int] = frozenset()) -> tuple[list[dict], bool]:
        where, args = ["1=1"], []
        if filter == "unread":
            where.append("read = 0")
        elif filter in ("mention", "reply"):
            where.append("kind = ?")
            args.append(filter)
        if before:
            where.append("ts < ?")
            args.append(before)
        if since:
            where.append("ts >= ?")
            args.append(since)
        if exclude_chats:
            where.append(f"chat_id NOT IN ({','.join('?' * len(exclude_chats))})")
            args += list(exclude_chats)
        rows = self.conn.execute(
            f"SELECT data, read, read_at FROM mentions WHERE {' AND '.join(where)} ORDER BY ts DESC LIMIT ?", [*args, limit + 1]).fetchall()
        items = [json.loads(r["data"]) | {"unread": not r["read"], "read_at": r["read_at"]} for r in rows[:limit]]
        return items, len(rows) > limit

    # ------------------------------------------------------------- threads
    def thread_root(self, chat_id: int, msg_id: int) -> int:
        """The thread a message id belongs to, if the app has seen it in one (else itself)."""
        row = self.conn.execute("SELECT root_id FROM thread_msgs WHERE chat_id = ? AND msg_id = ?", (chat_id, msg_id)).fetchone()
        return row["root_id"] if row else msg_id

    def thread_has(self, chat_id: int, msg_id: int) -> bool:
        return self.conn.execute("SELECT 1 FROM thread_msgs WHERE chat_id = ? AND msg_id = ?", (chat_id, msg_id)).fetchone() is not None

    def thread_get(self, chat_id: int, root_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM threads WHERE key = ?", (f"{chat_id}:{root_id}",)).fetchone()
        return dict(row) if row else None

    def thread_touch(self, chat_id: int, root_id: int, *, reply: dict | None = None, root: dict | None = None,
                     unread: bool = False, mine: bool = False, topic_id: int | None = None, ts: float | None = None) -> None:
        """Record activity in a thread you're in: a new reply (yours or someone's), or its root."""
        key = f"{chat_id}:{root_id}"
        ts = ts or (reply or {}).get("ts") or time.time()
        with self.conn:
            self.conn.execute(
                """INSERT INTO threads(key, chat_id, root_id, topic_id, root, last, last_ts, replies, unread, mine)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                     root = COALESCE(excluded.root, threads.root),
                     topic_id = COALESCE(excluded.topic_id, threads.topic_id),
                     last = CASE WHEN excluded.last_ts >= threads.last_ts AND excluded.last IS NOT NULL THEN excluded.last ELSE threads.last END,
                     last_ts = MAX(threads.last_ts, excluded.last_ts),
                     replies = threads.replies + excluded.replies,
                     unread = threads.unread + excluded.unread,
                     mine = MAX(threads.mine, excluded.mine)""",
                (key, chat_id, root_id, topic_id, _j(root), _j(reply), ts, 1 if reply else 0,
                 1 if unread else 0, 1 if mine else 0))
            if reply:
                self.conn.execute("INSERT OR REPLACE INTO thread_msgs VALUES(?, ?, ?)", (chat_id, reply["id"], root_id))
            self.conn.execute("INSERT OR IGNORE INTO thread_msgs VALUES(?, ?, ?)", (chat_id, root_id, root_id))

    def thread_set_root(self, chat_id: int, root_id: int, root: dict) -> None:
        with self.conn:
            self.conn.execute("UPDATE threads SET root = ? WHERE key = ?", (_j(root), f"{chat_id}:{root_id}"))

    def thread_read(self, chat_id: int, root_id: int) -> bool:
        with self.conn:
            cur = self.conn.execute("UPDATE threads SET unread = 0 WHERE key = ? AND unread > 0", (f"{chat_id}:{root_id}",))
        return cur.rowcount > 0

    def thread_mark_unread(self, chat_id: int, root_id: int) -> bool:
        with self.conn:
            cur = self.conn.execute("UPDATE threads SET unread = MAX(unread, 1) WHERE key = ?", (f"{chat_id}:{root_id}",))
        return cur.rowcount > 0

    def thread_read_all(self, exclude_chats: set[int] = frozenset()) -> int:
        rows = [r["key"] for r in self.conn.execute("SELECT key, chat_id FROM threads WHERE unread > 0") if r["chat_id"] not in exclude_chats]
        with self.conn:
            self.conn.executemany("UPDATE threads SET unread = 0 WHERE key = ?", [(k,) for k in rows])
        return len(rows)

    def thread_unread_count(self, exclude_chats: set[int] = frozenset()) -> int:
        rows = self.conn.execute("SELECT chat_id FROM threads WHERE unread > 0")
        return sum(1 for r in rows if r["chat_id"] not in exclude_chats)

    def thread_list(self, *, limit: int = 50, before: float | None = None, unread_only: bool = False,
                    exclude_chats: set[int] = frozenset()) -> tuple[list[dict], bool]:
        where, args = ["1=1"], []
        if before:
            where.append("last_ts < ?")
            args.append(before)
        if unread_only:
            where.append("unread > 0")
        if exclude_chats:
            where.append(f"chat_id NOT IN ({','.join('?' * len(exclude_chats))})")
            args += list(exclude_chats)
        rows = self.conn.execute(f"SELECT * FROM threads WHERE {' AND '.join(where)} ORDER BY last_ts DESC LIMIT ?",
                                 [*args, limit + 1]).fetchall()
        out = []
        for r in rows[:limit]:
            d = dict(r)
            d["root"] = json.loads(d["root"]) if d["root"] else None
            d["last"] = json.loads(d["last"]) if d["last"] else None
            out.append(d)
        return out, len(rows) > limit

    # ------------------------------------------------------------- frecency (Slack's quick switcher)
    VISIT_WEIGHT = {"send": 2.0, "switch": 1.5, "open": 1.0}

    def add_visit(self, chat_id: int, kind: str, q: str | None = None) -> None:
        now = time.time()
        with self.conn:
            if kind == "open":  # reopening the same chat within a minute isn't another visit
                last = self.conn.execute("SELECT ts FROM visits WHERE chat_id = ? AND kind = 'open' ORDER BY ts DESC LIMIT 1", (chat_id,)).fetchone()
                if last and now - last["ts"] < 60:
                    return
            self.conn.execute("INSERT INTO visits VALUES(?, ?, ?, ?)", (chat_id, now, kind, (q or "")[:40] or None))
            self.conn.execute("DELETE FROM visits WHERE ts < ?", (now - 180 * 86400,))  # keep half a year

    def frecency(self, now: float | None = None) -> dict[int, float]:
        """Firefox/Slack-style frecency: the average weight of your last 10 visits (recent ones count
        more) times how many times you've been there."""
        now = now or time.time()
        def bucket(age_days: float) -> int:
            return 100 if age_days <= 4 else 70 if age_days <= 14 else 50 if age_days <= 31 else 30 if age_days <= 90 else 10
        out: dict[int, float] = {}
        rows = self.conn.execute("SELECT chat_id, ts, kind FROM visits ORDER BY chat_id, ts DESC").fetchall()
        by_chat: dict[int, list] = {}
        for r in rows:
            by_chat.setdefault(r["chat_id"], []).append(r)
        for chat_id, vs in by_chat.items():
            sample = vs[:10]
            pts = sum(bucket((now - v["ts"]) / 86400) * self.VISIT_WEIGHT.get(v["kind"], 1.0) for v in sample) / len(sample)
            out[chat_id] = pts * len(vs)
        return out

    def picks(self, limit: int = 300) -> list[list]:
        """What you typed in ⌘K before choosing a chat: [query, chat_id, times] (Slack learns these)."""
        rows = self.conn.execute(
            "SELECT lower(q) AS q, chat_id, COUNT(*) AS n FROM visits WHERE kind = 'switch' AND q IS NOT NULL "
            "GROUP BY lower(q), chat_id ORDER BY n DESC LIMIT ?", (limit,)).fetchall()
        return [[r["q"], r["chat_id"], r["n"]] for r in rows]

    # ------------------------------------------------------------- thread accuracy labels
    def add_labels(self, items: list[dict]) -> int:
        now = time.time()
        with self.conn:
            for it in items:
                self.conn.execute(
                    "INSERT OR REPLACE INTO thread_labels VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (f"{it['chat_id']}:{it['msg_id']}:{it['kind']}", int(it["chat_id"]), int(it["msg_id"]), str(it["kind"]),
                     it.get("root_id"), 1 if it["verdict"] else 0, it.get("rules"), now,
                     json.dumps(it.get("data") or {}, ensure_ascii=False)))
        return len(items)

    def label_summary(self, rules: str | None = None) -> dict:
        q = "SELECT kind, COUNT(*) n, SUM(verdict) ok FROM thread_labels"
        args: list = []
        if rules:
            q += " WHERE rules = ?"
            args.append(rules)
        rows = self.conn.execute(q + " GROUP BY kind", args).fetchall()
        return {r["kind"]: {"n": r["n"], "ok": r["ok"] or 0} for r in rows}

    def labeled_keys(self) -> list[str]:
        return [r["key"] for r in self.conn.execute("SELECT key FROM thread_labels")]


def _j(v) -> str | None:
    return None if v is None else json.dumps({k: x for k, x in v.items() if k not in DROP}, ensure_ascii=False, default=str)
