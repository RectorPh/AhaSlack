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
