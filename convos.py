"""Past Inbox Manager conversations, so the user can look back at them and pick one up again.

"New conversation" used to throw the old one away. Now the old one is kept here, one JSON file
per conversation: {id, started, updated, title, session_id, history}. Plain files, no telethon or
SDK imports, so the tests can use it directly.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path

_ID = re.compile(r"^[0-9a-f]{12}$")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def title_of(history: list[dict]) -> str:
    first = next((m.get("text", "") for m in history if m.get("role") == "user"), "")
    first = " ".join(first.split())
    return first[:80] + ("…" if len(first) > 80 else "") or "Untitled conversation"


def summary(convo: dict) -> dict:
    h = convo.get("history", [])
    return {"id": convo["id"], "title": convo.get("title") or title_of(h), "started": convo.get("started"),
            "updated": convo.get("updated"), "count": sum(1 for m in h if m.get("role") == "user")}


class Archive:
    def __init__(self, folder: Path):
        self.dir = folder

    def _path(self, cid: str) -> Path:
        if not _ID.match(cid or ""):
            raise KeyError(cid)
        return self.dir / f"{cid}.json"

    def save(self, convo: dict) -> None:
        """Keep a finished conversation. Empty ones (nothing asked yet) aren't worth keeping."""
        if not any(m.get("role") == "user" for m in convo.get("history", [])):
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        convo = {**convo, "title": convo.get("title") or title_of(convo["history"]),
                 "updated": convo.get("updated") or time.time()}
        p = self._path(convo["id"])
        p.write_text(json.dumps(convo, ensure_ascii=False), "utf-8")
        os.chmod(p, 0o600)

    def list(self) -> list[dict]:
        out = []
        for p in self.dir.glob("*.json") if self.dir.exists() else []:
            try:
                out.append(summary(json.loads(p.read_text("utf-8"))))
            except (ValueError, KeyError):
                continue  # a half-written or foreign file: skip it, don't break the list
        return sorted(out, key=lambda c: c.get("updated") or 0, reverse=True)

    def load(self, cid: str) -> dict:
        p = self._path(cid)
        if not p.exists():
            raise KeyError(cid)
        return json.loads(p.read_text("utf-8"))

    def remove(self, cid: str) -> None:
        p = self._path(cid)
        if not p.exists():
            raise KeyError(cid)
        p.unlink()
