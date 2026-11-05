#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["telethon>=1.36", "fastapi>=0.110", "uvicorn>=0.29", "claude-agent-sdk>=0.2"]
# ///
"""Inbox Manager web app: a Slack-style page for your Telegram inbox.

    uv run --script server.py          # then open http://127.0.0.1:8765

Listens on 127.0.0.1 only. Reads Telegram with your logged-in session (run login.py first);
never sends anything or marks anything as read. The manager chat uses your Claude Code login.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import tg
import triage
from agent import Manager
from live import Live
from db import MentionDB
import stickers

STATIC = Path(__file__).with_name("static")
STATE_FILE = tg.HOME / "ui_state.json"
PORT = int(os.environ.get("INBOX_PORT", "8765"))


class Inbox:
    """Everything the UI and the manager agent read from."""

    def __init__(self):
        self.cfg = tg.load_config()
        self.client = tg.make_client(in_memory=True)
        self.me = None
        self.chats: list[tg.Chat] = []
        self.report: dict | None = None
        self.mentions: list[dict] = []
        self.mentions_days = 0.0
        self.mentions_at = 0.0
        self.done: set[str] = set()
        self.status = "starting"
        self.refreshing = False
        self._mention_lock = asyncio.Lock()
        self._refresh_task: asyncio.Task | None = None
        self.shortcuts: dict[str, str] = {}  # user overrides of the default keyboard shortcuts
        self.ignored: set[int] = set()        # chats the user ignored from the app's sidebar
        self.ui: dict = {}                     # sidebar sort/show, starred chats, read behavior, ...
        self.topics: dict[int, list[dict]] = {}  # forum group id -> its topics (Telegram Topics = Slack channels)
        self.db = MentionDB(tg.HOME / "inbox.db")  # Activity history: every mention/reply, kept for good
        if STATE_FILE.exists():
            saved = json.loads(STATE_FILE.read_text())
            self.done = set(saved.get("done", []))
            self.shortcuts = saved.get("shortcuts", {})
            self.ignored = set(saved.get("ignored", []))
            self.ui = saved.get("ui", {})
        self._apply_ignored()

    def _apply_ignored(self) -> None:
        """Chats ignored in the app count as config.toml's ignore_chats everywhere
        (triage, mentions, the manager), on top of what the file lists."""
        base = [p for p in tg.load_config().ignore_chats]
        self.cfg.ignore_chats = base + [str(i) for i in sorted(self.ignored)]

    async def start(self) -> None:
        self.me = await tg.connect(self.client)
        self.chats = await tg.load_chats(self.client, self.cfg.include_archived)
        latest = tg.CACHE / "latest.json"
        if latest.exists():
            self.report = json.loads(latest.read_text("utf-8"))
        self.status = "ready"
        self.live = Live(self)
        self.live.attach()  # real-time: Telegram pushes new messages, edits, deletes and reads
        asyncio.create_task(self.load_top_peers())
        asyncio.create_task(self.load_all_topics())
        asyncio.create_task(self.refresh_mentions(7 if self.db.get_meta("backfilled") else 30))
        if not latest.exists() or time.time() - latest.stat().st_mtime > 6 * 3600:  # live sync covers the rest
            self.start_refresh()

    async def load_topics(self, chat: tg.Chat) -> list[dict]:
        try:
            self.topics[chat.id] = await tg.forum_topics(self.client, chat)
        except Exception as exc:  # noqa: BLE001 - keep the old list
            print(f"topics failed for {chat.name}: {exc}", file=sys.stderr)
        return self.topics.get(chat.id, [])

    async def load_all_topics(self) -> None:
        for c in [c for c in self.chats if c.forum]:
            await self.load_topics(c)

    def topic(self, chat_id: int, topic_id: int | None) -> dict | None:
        return next((t for t in self.topics.get(chat_id, []) if t["id"] == topic_id), None)

    def chat_by_id(self, chat_id: int) -> tg.Chat | None:
        return next((c for c in self.chats if c.id == chat_id), None)

    # ------------------------------------------------------------- threads you're in
    def thread_of(self, chat_id: int, m: dict) -> int | None:
        """Rule 1 (reply chains): the root of the thread a message replies into."""
        cand = m.get("thread_top") or m.get("reply_to")
        return self.db.thread_root(chat_id, cand) if cand else None

    def track_thread(self, chat: tg.Chat, m: dict, *, root: int | None = None, unread: bool | None = None) -> dict | None:
        """Note a reply in a thread you're in (you replied in it, or it replies to you)."""
        root = root or self.thread_of(chat.id, m)
        if not root or root == m["id"] or self.db.thread_has(chat.id, m["id"]):
            return None
        known = self.db.thread_get(chat.id, root)
        to_me = m.get("reply_to_me") or "reply_to_me" in (m.get("flags") or [])
        if not (known or m["out"] or to_me):
            return None
        if unread is None:
            unread = not m["out"] and chat.id not in self.ignored
        self.db.thread_touch(chat.id, root, reply=m, unread=unread, mine=m["out"], topic_id=m.get("topic_id"), ts=m.get("ts"))
        if not (known and known.get("root")):
            asyncio.create_task(self.fill_thread_roots(chat, [root]))
        return {"key": f"{chat.id}:{root}", "root_id": root, "unread": self.db.thread_unread_count(self.ignored)}

    async def fill_thread_roots(self, chat: tg.Chat, roots: list[int]) -> None:
        try:
            got = await self.client.get_messages(chat.entity, ids=roots)
        except Exception as exc:  # noqa: BLE001 - shown without its root until next time
            print(f"thread roots in {chat.name}: {exc}", file=sys.stderr)
            return
        tz = tg.ZoneInfo(self.cfg.timezone)
        for r in got:
            if r is not None:
                self.db.thread_set_root(chat.id, r.id, tg.to_dict(r, chat.entity, tz, 1500))

    # ------------------------------------------------------------- affinity: who and where you go most
    top: dict[int, float] = {}
    top_at: float = 0.0

    async def load_top_peers(self) -> None:
        try:
            self.top, self.top_at = await tg.top_peers(self.client), time.time()
        except Exception as exc:  # noqa: BLE001 - ranking just uses your own visits then
            print(f"top peers: {exc}", file=sys.stderr)

    def affinity(self) -> dict[str, int]:
        """0..100 per chat: how much you use it. Your visits and messages in AhaSlack (frecency),
        with Telegram's "most used" list as a head start, like Slack's quick switcher."""
        if time.time() - self.top_at > 6 * 3600:
            asyncio.create_task(self.load_top_peers())
            self.top_at = time.time()  # don't pile up refreshes
        import math
        fr = self.db.frecency()
        out = {}
        for cid in set(fr) | set(self.top):
            app = 1 - math.exp(-fr.get(cid, 0) / 400)
            a = round(100 * min(1.0, 0.65 * app + 0.55 * self.top.get(cid, 0)))
            if a > 0:
                out[str(cid)] = a
        return out

    def save_state(self) -> None:
        STATE_FILE.write_text(json.dumps({"done": sorted(self.done), "shortcuts": self.shortcuts,
                                          "ignored": sorted(self.ignored), "ui": self.ui}))
        os.chmod(STATE_FILE, 0o600)

    async def refresh_mentions(self, days: float | None = None) -> None:
        async with self._mention_lock:
            days = max(days or self.mentions_days or 14, 1)
            self.mentions = await tg.fetch_mentions(self.client, self.cfg, self.chats, days)
            self.mentions_days, self.mentions_at = days, time.time()
            for m in self.mentions:
                m["topic"] = (self.topic(m["chat"]["id"], m.get("topic_id")) or {}).get("title")
            # into the Activity database; anything you marked done before counts as read
            self.db.upsert(self.mentions, read_keys=self.done)
            for m in sorted(self.mentions, key=lambda x: x["ts"]):  # replies to you start threads you're in
                c = self.chat_by_id(m["chat"]["id"])
                if c and m.get("kind") == "reply":
                    self.track_thread(c, m | {"reply_to_me": True}, unread=m["unread"] and m["key"] not in self.done)
            if days >= 30:
                self.db.set_meta("backfilled", time.time())

    async def get_mentions(self, days: float) -> list[dict]:
        """Mentions from the Activity database (used by the manager agent)."""
        if time.time() - self.mentions_at > 1800:
            await self.refresh_mentions(7)
        items, _ = self.db.list(limit=1000, since=time.time() - days * 86400, exclude_chats=self.ignored)
        return items

    def start_refresh(self) -> None:
        if self._refresh_task and not self._refresh_task.done():
            return
        self._refresh_task = asyncio.create_task(self._refresh())

    async def _refresh(self) -> None:
        self.refreshing = True
        try:
            self.chats = await tg.load_chats(self.client, self.cfg.include_archived)
            await self.refresh_mentions()
            self.report = await tg.snapshot(self.client, self.me, self.cfg, self.chats)
            tg.save_snapshot(self.report)
        except Exception as exc:  # noqa: BLE001 - keep the server up, show the error
            self.status = f"refresh failed: {type(exc).__name__}: {exc}"
            print(self.status, file=sys.stderr)
        else:
            self.status = "ready"
        finally:
            self.refreshing = False


inbox: Inbox | None = None
manager: Manager | None = None


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    global inbox, manager
    inbox = Inbox()
    await inbox.start()
    manager = Manager(inbox)
    manager.start()
    yield
    await inbox.client.disconnect()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


@app.middleware("http")
async def only_this_page(request: Request, call_next):
    """Block other websites from driving this server: a wrong Host means DNS rebinding,
    and a state-changing request (send, ask, refresh) must carry our custom header, which a
    cross-site form can't add and a cross-site fetch can't add without a CORS preflight we never allow."""
    if request.headers.get("host") not in ALLOWED_HOSTS:
        return JSONResponse({"error": "forbidden host"}, status_code=403)
    if request.method not in ("GET", "HEAD"):
        origin = request.headers.get("origin")
        if request.headers.get("x-inbox") != "1" or (origin and urlparse(origin).netloc not in ALLOWED_HOSTS):
            return JSONResponse({"error": "forbidden"}, status_code=403)
    return await call_next(request)


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


SIDEBAR_DAYS = 45


def sidebar(rep: dict) -> list[dict]:
    """Every chat with unread messages or activity in the last SIDEBAR_DAYS, with its tier."""
    tiers = {e["id"]: e for e in rep.get("chats", [])}
    cutoff = time.time() - SIDEBAR_DAYS * 86400
    out = []
    for c in inbox.chats:
        info = c.info()
        entry = tiers.get(c.id)
        if not entry and info["last_ts"] < cutoff and not info["unread_count"]:
            continue
        ignored = c.id in inbox.ignored
        live = inbox.live.tiers.get(c.id)
        if live and not ignored:
            entry = {"tier": live[0], "reasons": live[1]}
        out.append({k: info[k] for k in ("id", "name", "username", "kind", "muted", "unread_count", "unread_mentions", "photo", "last_ts", "link", "forum")}
                   | {"tier": "noise" if ignored else (entry["tier"] if entry else None),
                      "why": "ignored by you" if ignored else ("; ".join(entry["reasons"]) if entry else ""),
                      "ignored": ignored})
    return out


@app.get("/api/state")
async def state():
    rep = inbox.report or {"chats": [], "totals": {}, "generated_at": None}

    return {
        "me": {"name": tg.utils.get_display_name(inbox.me), "username": inbox.me.username,
               "peer": inbox.me.id, "photo": tg.photo_id(inbox.me)},
        "status": inbox.status,
        "sending_enabled": inbox.cfg.sending_enabled,
        "mark_read_enabled": inbox.cfg.mark_read_enabled,
        "timezone": inbox.cfg.timezone,
        "refreshing": inbox.refreshing,
        "live": inbox.client.is_connected(),
        "snapshot_at": rep.get("generated_at"),
        "totals": rep.get("totals"),
        "mentions_unread": inbox.db.unread_count(inbox.ignored),
        "threads_unread": inbox.db.thread_unread_count(inbox.ignored),
        "affinity": inbox.affinity(),
        "picks": inbox.db.picks(),
        "chats": (chats := sidebar(rep)),
        "topics": {str(c["id"]): [{k: t[k] for k in ("id", "title", "unread_count", "unread_mentions", "last_ts", "closed", "pinned", "hidden")}
                                  for t in inbox.topics.get(c["id"], [])] for c in chats if c.get("forum")},
        "history": manager.history,
    }


AVATARS = tg.CACHE / "avatars"
_avatar_gate = asyncio.Semaphore(6)


@app.get("/api/avatar/{peer}")
async def avatar(peer: int):
    entity = tg.ENTITIES.get(peer) or (inbox.me if peer == inbox.me.id else None)
    if entity is None:
        raise HTTPException(404)
    async with _avatar_gate:
        try:
            path = await tg.download_avatar(inbox.client, entity, AVATARS)
        except Exception:  # noqa: BLE001 - hidden or expired photo: fall back to initials
            path = None
    if not path:
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/search")
async def search(q: str, chat: int | None = None, days: float | None = None):
    c = inbox.chat_by_id(chat) if chat else None
    items = await tg.search(inbox.client, inbox.cfg, q, c, days, limit=50)
    for m in items:
        m["topic"] = (inbox.topic(m["chat"]["id"], m.get("topic_id")) or {}).get("title")
    return {"items": items}


@app.post("/api/refresh")
async def refresh():
    inbox.start_refresh()
    return {"ok": True}


@app.get("/api/mentions")
async def mentions(filter: str = "all", limit: int = 100, before: float | None = None, refresh: bool = False):
    """Activity: every mention and reply to you, newest first, with Slack-style read state."""
    if refresh or time.time() - inbox.mentions_at > 1800:
        await inbox.refresh_mentions(7)
    items, more = inbox.db.list(filter=filter, limit=min(limit, 300), before=before, exclude_chats=inbox.ignored)
    for m in items:
        if m.get("topic_id") and not m.get("topic"):
            m["topic"] = (inbox.topic(m["chat"]["id"], m["topic_id"]) or {}).get("title")
    return {"items": items, "has_more": more, "unread": inbox.db.unread_count(inbox.ignored), "fetched_at": inbox.mentions_at}


async def _clear_on_telegram(rows: list[dict]) -> None:
    """Seen in the app: clear Telegram's @ mark on those messages (only them, not the chats)."""
    if not inbox.cfg.mark_read_enabled:
        return
    by_chat: dict[int, list[int]] = {}
    for r in rows:
        by_chat.setdefault(r["chat_id"], []).append(r["msg_id"])
    for chat_id, ids in by_chat.items():
        c = inbox.chat_by_id(chat_id)
        if c:
            try:
                await tg.read_mentions(inbox.client, c, ids)
            except Exception as exc:  # noqa: BLE001 - the app's own read state still counts
                print(f"clearing mentions in {c.name} failed: {exc}", file=sys.stderr)


@app.post("/api/mentions/read")
async def mentions_read(request: Request):
    """Mark mentions read (seen) or unread, like Slack's Activity."""
    body = await request.json()
    keys = [k for k in body.get("keys", []) if isinstance(k, str)][:500]
    read = bool(body.get("read", True))
    rows = inbox.db.unread_keys(keys) if read else []
    inbox.db.mark(keys, read)
    for m in inbox.mentions:
        if m["key"] in keys:
            m["unread"] = not read
    asyncio.create_task(_clear_on_telegram(rows))
    return {"ok": True, "unread": inbox.db.unread_count(inbox.ignored)}


@app.post("/api/mentions/read-all")
async def mentions_read_all():
    rows = inbox.db.mark_all_read(inbox.ignored)
    for m in inbox.mentions:
        m["unread"] = False
    asyncio.create_task(_clear_on_telegram(rows))
    return {"ok": True, "count": len(rows), "unread": 0}


@app.post("/api/mentions/{key}/done")
async def toggle_done(key: str, request: Request):
    body = await request.json()
    (inbox.done.add if body.get("done", True) else inbox.done.discard)(key)
    inbox.save_state()
    return {"ok": True}


@app.post("/api/mentions-done")
async def mentions_done_many(request: Request):
    """Mark many mentions done (or not done) at once: the "Mark all done" button."""
    body = await request.json()
    keys = [k for k in body.get("keys", []) if isinstance(k, str)]
    if body.get("done", True):
        inbox.done.update(keys)
    else:
        inbox.done.difference_update(keys)
    inbox.save_state()
    return {"ok": True, "count": len(keys)}


@app.post("/api/chat/{chat_id}/ignore")
async def ignore_chat(chat_id: int, request: Request):
    """Ignore a chat (it leaves "Needs you" and its mentions disappear) or stop ignoring it."""
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    ignored = bool((await request.json()).get("ignored", True))
    (inbox.ignored.add if ignored else inbox.ignored.discard)(chat_id)
    inbox._apply_ignored()
    inbox.save_state()
    asyncio.create_task(inbox.refresh_mentions())  # drop (or bring back) its mentions
    return {"ok": True, "ignored": ignored, "name": c.name}


def _mark_read_allowed() -> None:
    if not inbox.cfg.mark_read_enabled:
        raise HTTPException(403, "Marking as read is off. Set mark_read_enabled = true in config.toml and restart.")


async def _mark_read(c: tg.Chat) -> None:
    await inbox.client.send_read_acknowledge(c.entity, clear_mentions=True)
    d = c.dialog
    d.unread_count = d.unread_mentions_count = 0
    last = getattr(d, "message", None)
    if last is not None:
        d.dialog.read_inbox_max_id = max(d.dialog.read_inbox_max_id or 0, last.id)
    for m in inbox.mentions:
        if m["chat"]["id"] == c.id:
            m["unread"] = False


@app.post("/api/chat/{chat_id}/read")
async def mark_read(chat_id: int, topic: int | None = None):
    """Esc in a chat, like Slack: mark it read on Telegram (or just one topic of a forum group)."""
    _mark_read_allowed()
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    if topic and c.forum:
        t = inbox.topic(chat_id, topic)
        top = t["top_message"] if t else getattr(c.dialog.message, "id", 0)
        await tg.read_topic(inbox.client, c, topic, top)
        if t:
            gone = t["unread_count"]
            t.update(unread_count=0, unread_mentions=0, read_upto=max(t["read_upto"], top))
            c.dialog.unread_count = max(0, (c.dialog.unread_count or 0) - gone)
        for m in inbox.mentions:
            if m["chat"]["id"] == chat_id and m.get("topic_id") == topic:
                m["unread"] = False
        inbox.db.mark_chat_read(chat_id, top, topic)
        return {"ok": True, "name": c.name}
    await _mark_read(c)
    inbox.db.mark_chat_read(chat_id, getattr(c.dialog.message, "id", 0) or 2**31)
    return {"ok": True, "name": c.name}


@app.post("/api/chat/{chat_id}/unread")
async def mark_unread(chat_id: int):
    """⌥-click a message / U, like Slack (Telegram marks the whole chat unread)."""
    _mark_read_allowed()
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    await tg.mark_unread(inbox.client, c)
    return {"ok": True, "name": c.name}


@app.post("/api/chat/{chat_id}/save/{msg_id}")
async def save_message(chat_id: int, msg_id: int):
    """A on a message, like Slack's "save": forwards it to your Saved Messages."""
    if not inbox.cfg.sending_enabled:
        raise HTTPException(403, "Saving forwards to Saved Messages, which needs sending_enabled = true.")
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    await tg.save_to_saved(inbox.client, c, msg_id)
    print(f"saved message {msg_id} from {c.name} to Saved Messages", file=sys.stderr)
    return {"ok": True}


def _writes_allowed() -> None:
    if not inbox.cfg.sending_enabled:
        raise HTTPException(403, "This changes Telegram, which needs sending_enabled = true in config.toml.")


def _chat_or_404(chat_id: int) -> tg.Chat:
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    return c


async def _telegram(call, what: str):
    try:
        return await call
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    except Exception as exc:  # noqa: BLE001 - e.g. no rights to pin, message too old to edit
        raise HTTPException(400, f"Telegram refused to {what}: {exc}")


@app.post("/api/chat/{chat_id}/msg/{msg_id}/{op}")
async def message_action(chat_id: int, msg_id: int, op: str, request: Request):
    """Slack's message actions, done by the user: edit, delete/unsend, forward, pin, react, remind."""
    _writes_allowed()
    c = _chat_or_404(chat_id)
    body = await request.json() if (await request.body()) else {}
    if op == "edit":
        text = (body.get("text") or "").strip()
        if not text or len(text) > tg.MAX_TEXT:
            raise HTTPException(400, "text is empty or too long")
        return {"message": await _telegram(tg.edit_text(inbox.client, inbox.cfg, c, msg_id, text), "edit it")}
    if op == "delete":
        await _telegram(tg.delete_own(inbox.client, c, msg_id), "delete it")
    elif op == "forward":
        dst = _chat_or_404(int(body.get("to")))
        await _telegram(tg.forward_to(inbox.client, c, msg_id, dst), "forward it")
        inbox.db.add_visit(dst.id, "send")
        return {"ok": True, "to": dst.name}
    elif op == "pin":
        await _telegram(tg.set_pinned(inbox.client, c, msg_id, bool(body.get("pinned", True))), "pin it")
    elif op == "react":
        await _telegram(tg.react(inbox.client, c, msg_id, body.get("emoji") or None), "react")
    elif op == "remind":
        minutes = int(body.get("minutes") or 60)
        if not 1 <= minutes <= 60 * 24 * 30:
            raise HTTPException(400, "a reminder must be 1 minute to 30 days away")
        when = await _telegram(tg.remind(inbox.client, inbox.cfg, c, msg_id, minutes), "set a reminder")
        return {"ok": True, "at": when.astimezone(tg.ZoneInfo(inbox.cfg.timezone)).strftime("%a %d %b %H:%M")}
    else:
        raise HTTPException(404, "unknown action")
    print(f"{op} message {msg_id} in {c.name}", file=sys.stderr)
    return {"ok": True}


MAX_UPLOAD = 50 * 1024 * 1024


@app.post("/api/chat/{chat_id}/upload")
async def upload(chat_id: int, request: Request):
    """⌘O, like Slack: send a file (the page posts the raw bytes)."""
    _writes_allowed()
    c = _chat_or_404(chat_id)
    data = await request.body()
    if not data or len(data) > MAX_UPLOAD:
        raise HTTPException(400, "file is empty or larger than 50 MB")
    from urllib.parse import unquote
    name = unquote(request.headers.get("x-filename") or "file")[:200] or "file"
    caption = unquote(request.headers.get("x-caption") or "")[:1000]
    topic = int(request.headers.get("x-topic") or 0)
    reply_to = int(request.headers.get("x-reply-to") or 0) or None  # a reply in a thread
    if not reply_to and c.forum and topic and topic != tg.GENERAL_TOPIC:
        reply_to = topic  # posting into a topic
    msg = await _telegram(tg.send_upload(inbox.client, inbox.cfg, c, data, name, caption, reply_to), "send the file")
    print(f"uploaded {name} ({len(data)} bytes) to {c.name}", file=sys.stderr)
    inbox.db.add_visit(c.id, "send")
    root = int(request.headers.get("x-thread-root") or 0) or None
    if reply_to and reply_to != topic:
        inbox.track_thread(c, msg | {"ts": time.time()}, root=root)
    return {"message": msg}


@app.get("/api/status")
async def get_status():
    return {"about": await tg.get_bio(inbox.client)}


@app.post("/api/status")
async def set_status(request: Request):
    """⌘⇧Y, Slack's status: Telegram's bio (70 characters, or 140 with Premium)."""
    _writes_allowed()
    about = ((await request.json()).get("about") or "").strip()
    if len(about) > 140:
        raise HTTPException(400, "a Telegram bio is at most 70 characters (140 with Premium)")
    await _telegram(tg.set_bio(inbox.client, about), "update your bio")
    return {"ok": True, "about": about}


@app.get("/api/folders")
async def get_folders():
    """Telegram chat folders: the app's 'workspaces'."""
    try:
        return {"folders": await tg.folders(inbox.client, inbox.chats)}
    except Exception as exc:  # noqa: BLE001
        return {"folders": [{"id": 0, "title": "All chats", "emoji": "", "chats": [c.id for c in inbox.chats]}], "error": str(exc)}


@app.get("/api/downloads")
async def downloads():
    """⌘⇧J: the pictures this app has downloaded (Slack's 'downloaded files')."""
    out = []
    for p in sorted(MEDIA.glob("*_*.*"), key=lambda p: p.stat().st_mtime, reverse=True)[:300]:
        chat_id, _, msg_id = p.stem.rpartition("_")
        try:
            cid, mid = int(chat_id), int(msg_id)
        except ValueError:
            continue
        c = inbox.chat_by_id(cid)
        out.append({"chat_id": cid, "msg_id": mid, "chat": c.name if c else "?", "size": p.stat().st_size,
                    "ts": p.stat().st_mtime, "url": f"/api/media/{cid}/{mid}"})
    return {"items": out}


@app.post("/api/read-all")
async def mark_all_read():
    """Shift+Esc, like Slack: mark every unread chat read (the page asks first)."""
    _mark_read_allowed()
    done = 0
    for c in inbox.chats:
        if c.dialog.unread_count or c.dialog.unread_mentions_count or getattr(c.dialog.dialog, "unread_mark", False):
            try:
                await _mark_read(c)
                done += 1
            except Exception as exc:  # noqa: BLE001 - keep going; report what worked
                print(f"mark read failed for {c.name}: {exc}", file=sys.stderr)
    return {"ok": True, "count": done}


@app.get("/api/unreads")
async def unreads():
    """All unreads, like Slack: every chat with unread messages and its latest unread ones."""
    entries = {e["id"]: e for e in (inbox.report or {}).get("chats", [])}
    out = []
    for c in inbox.chats:
        info = c.info()
        if not info["unread_count"] or c.id in inbox.ignored:
            continue
        e = entries.get(c.id)
        msgs = [m | {"chat_id": m.get("chat_id", c.id)} for m in (e["messages"] if e else [])][-4:]
        out.append({"chat": info, "tier": e["tier"] if e else None, "why": e["reasons"] if e else [], "messages": msgs})
    order = {"must": 0, "maybe": 1, None: 2, "noise": 3}
    out.sort(key=lambda x: (order.get(x["tier"], 2), -x["chat"]["last_ts"]))
    return {"items": out}


@app.get("/api/chat/{chat_id}")
async def chat(chat_id: int, limit: int = 60, around: int | None = None, before: int | None = None, topic: int | None = None):
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    win = await tg.chat_window(inbox.client, inbox.cfg, c, limit=min(limit, 200), around=around, before=before, topic=topic)
    t = inbox.topic(chat_id, topic) if topic else None
    entry = next((e for e in (inbox.report or {}).get("chats", []) if e["id"] == chat_id), None)
    for m in win["messages"]:
        m["flags"] = triage.message_flags(m, inbox.cfg)
    return {"chat": c.info(), "tier": entry and entry["tier"], "why": entry and entry["reasons"], "topic": t,
            "read_upto": t["read_upto"] if t else getattr(c.dialog.dialog, "read_inbox_max_id", 0), **win}


_speakers: dict[int, tuple[float, list]] = {}


@app.get("/api/chat/{chat_id}/members")
async def chat_members(chat_id: int, q: str = "", limit: int = 12):
    """Who you can @-tag here (the composer's mention picker)."""
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    at, recent = _speakers.get(chat_id, (0.0, []))
    if time.time() - at > 300 and c.kind != "dm":
        recent = await tg.recent_speakers(inbox.client, c)
        _speakers[chat_id] = (time.time(), recent)
    return {"members": await tg.members(inbox.client, c, q.strip().lstrip("@"), min(limit, 30), recent)}


@app.get("/api/chat/{chat_id}/msg/{msg_id}/reactions")
async def msg_reactions(chat_id: int, msg_id: int):
    """Who reacted to this message (right-click a reaction)."""
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    try:
        return {"people": await tg.reactors(inbox.client, c, msg_id)}
    except PermissionError as exc:
        raise HTTPException(403, str(exc))


@app.post("/api/visit")
async def visit(request: Request):
    """You opened a chat (or picked it in ⌘K after typing q): feeds search ranking."""
    body = await request.json()
    kind = body.get("kind") if body.get("kind") in ("open", "switch") else "open"
    inbox.db.add_visit(int(body["chat_id"]), kind, (body.get("q") or "").strip().lower() or None)
    return {"ok": True}


@app.get("/api/chat/{chat_id}/topics")
async def chat_topics(chat_id: int):
    """A forum group's topics, fresh from Telegram."""
    c = inbox.chat_by_id(chat_id)
    if not c or not c.forum:
        raise HTTPException(404, "not a group with Topics")
    return {"topics": await inbox.load_topics(c)}


@app.get("/api/events")
async def event_stream():
    """Server-Sent Events: every new message, edit, delete and read, as it happens."""
    async def gen():
        async for ev in inbox.live.stream():
            yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.get("/api/stickers")
async def sticker_library():
    """Your recent, favorite and installed stickers, plus your custom emoji sets."""
    return await stickers.library(inbox.client)


@app.get("/api/stickers/set/{set_id}/{access_hash}")
async def sticker_set(set_id: int, access_hash: int):
    return {"stickers": await stickers.sticker_set(inbox.client, set_id, access_hash)}


@app.get("/api/sticker/{doc_id}")
async def sticker_file(doc_id: int, thumb: bool = False):
    async with _media_gate:
        try:
            got = await stickers.file_for(inbox.client, doc_id, thumb)
        except Exception:  # noqa: BLE001
            got = None
    if not got:
        raise HTTPException(404)
    path, mime = got
    return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, max-age=2592000"})


@app.post("/api/chat/{chat_id}/sticker")
async def send_sticker(chat_id: int, request: Request):
    _writes_allowed()
    c = _chat_or_404(chat_id)
    body = await request.json()
    doc_id = int(body.get("doc_id"))
    topic = int(body.get("topic") or 0)
    try:
        msg = await stickers.send_sticker(inbox.client, inbox.cfg, c, doc_id,
                                          topic if c.forum and topic and topic != tg.GENERAL_TOPIC else None)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Telegram refused the sticker: {exc}")
    inbox.db.add_visit(c.id, "send")
    return {"message": msg}


@app.get("/api/gifts")
async def gift_list():
    """Gifts on your profile and Telegram's gift catalog (view only: gifts cost Stars)."""
    return await stickers.gifts(inbox.client)


@app.get("/api/chats")
async def all_chats():
    """Every dialog, for the quick switcher and group search."""
    return {"chats": [{k: i[k] for k in ("id", "name", "username", "kind", "muted", "archived",
                                         "unread_count", "unread_mentions", "photo", "last_ts")}
                      for i in (c.info() for c in inbox.chats)]}


MEDIA = tg.CACHE / "media"
_media_gate = asyncio.Semaphore(4)


@app.get("/api/media/{chat_id}/{msg_id}")
async def media(chat_id: int, msg_id: int):
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404)
    async with _media_gate:
        try:
            got = await tg.download_image(inbox.client, c, msg_id, MEDIA)
        except Exception:  # noqa: BLE001 - expired file reference, deleted message, ...
            got = None
    if not got:
        raise HTTPException(404)
    path, mime = got
    return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, max-age=604800"})


@app.get("/api/prefs")
async def get_prefs():
    return {"shortcuts": inbox.shortcuts, "ui": inbox.ui}


@app.post("/api/prefs")
async def set_prefs(request: Request):
    body = await request.json()
    if "shortcuts" in body:
        shortcuts = body["shortcuts"]
        if not isinstance(shortcuts, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in shortcuts.items()):
            raise HTTPException(400, "shortcuts must be an object of action -> key combo")
        inbox.shortcuts = shortcuts
    if "ui" in body:
        if not isinstance(body["ui"], dict) or len(json.dumps(body["ui"])) > 100_000:
            raise HTTPException(400, "ui must be a small object")
        inbox.ui = body["ui"]
    inbox.save_state()
    return {"ok": True}


@app.post("/api/chat/{chat_id}/send")
async def send(chat_id: int, request: Request):
    """Send a message the user typed and confirmed in the composer."""
    if not inbox.cfg.sending_enabled:
        raise HTTPException(403, "Sending is off. Set sending_enabled = true in config.toml and restart.")
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "empty message")
    if len(text) > tg.MAX_TEXT:
        raise HTTPException(400, f"message is longer than Telegram's {tg.MAX_TEXT} characters")
    reply_to = body.get("reply_to")
    topic = body.get("topic")
    if not reply_to and topic and int(topic) != tg.GENERAL_TOPIC and c.forum:
        reply_to = int(topic)  # posting "into" a topic is a reply to its first message
    try:
        msg = await tg.send_text(inbox.client, inbox.cfg, c, text, int(reply_to) if reply_to else None)
    except Exception as exc:  # noqa: BLE001 - e.g. no permission to post in a channel
        raise HTTPException(400, f"Telegram refused: {exc}")
    print(f"sent message {msg['id']} to {c.name}", file=sys.stderr)
    inbox.db.add_visit(c.id, "send")
    root = body.get("thread_root")
    if reply_to and (not c.forum or int(reply_to) != int(topic or 0)):  # a reply joins its thread
        inbox.track_thread(c, msg | {"ts": time.time()}, root=int(root) if root else None)
    return {"message": msg, "chat": c.name}


# ---------------------------------------------------------------- threads (Slack-style)
@app.get("/api/chat/{chat_id}/thread/{msg_id}")
async def chat_thread(chat_id: int, msg_id: int, topic: int | None = None):
    """The whole thread a message belongs to: its root and every reply under it."""
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    try:
        t = await tg.thread(inbox.client, inbox.cfg, c, msg_id, topic)
    except LookupError:
        raise HTTPException(404, "That message is no longer available")
    for m in [t["root"], *t["replies"]]:
        m["flags"] = triage.message_flags(m, inbox.cfg)
    known = inbox.db.thread_get(chat_id, t["root"]["id"])
    return t | {"following": bool(known), "unread": (known or {}).get("unread", 0)}


@app.get("/api/threads")
async def threads(limit: int = 30, before: float | None = None, unread: bool = False):
    """Slack's Threads view: threads you're in, latest activity first."""
    items, more = inbox.db.thread_list(limit=min(limit, 100), before=before, unread_only=unread, exclude_chats=inbox.ignored)
    missing: dict[int, list[int]] = {}
    for t in items:
        if not t["root"]:
            missing.setdefault(t["chat_id"], []).append(t["root_id"])
    for chat_id, roots in missing.items():
        c = inbox.chat_by_id(chat_id)
        if c:
            await inbox.fill_thread_roots(c, roots)
    if missing:
        items, more = inbox.db.thread_list(limit=min(limit, 100), before=before, unread_only=unread, exclude_chats=inbox.ignored)
    out = []
    for t in items:
        c = inbox.chat_by_id(t["chat_id"])
        if not c:
            continue
        topic = inbox.topic(c.id, t["topic_id"]) if c.forum and t["topic_id"] else None
        out.append(t | {"chat": c.info(), "topic": topic and topic["title"]})
    return {"items": out, "has_more": more, "unread": inbox.db.thread_unread_count(inbox.ignored)}


@app.post("/api/threads/read")
async def threads_read(request: Request):
    """You opened a thread: its new replies are seen (in the app only; Telegram is untouched)."""
    body = await request.json()
    if body.get("read", True):
        inbox.db.thread_read(int(body["chat_id"]), int(body["root_id"]))
    else:
        inbox.db.thread_mark_unread(int(body["chat_id"]), int(body["root_id"]))
    return {"ok": True, "unread": inbox.db.thread_unread_count(inbox.ignored)}


@app.post("/api/threads/read-all")
async def threads_read_all():
    """Mark every thread you're in as read (in the app; Telegram is untouched)."""
    n = inbox.db.thread_read_all(inbox.ignored)
    return {"ok": True, "count": n, "unread": 0}


@app.get("/api/context/{chat_id}/{msg_id}")
async def context(chat_id: int, msg_id: int):
    c = inbox.chat_by_id(chat_id)
    if not c:
        raise HTTPException(404, "unknown chat")
    try:
        return await tg.message_context(inbox.client, inbox.cfg, c, msg_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc))


@app.post("/api/ask")
async def ask(request: Request):
    prompt = ((await request.json()).get("message") or "").strip()
    if not prompt:
        raise HTTPException(400, "empty message")

    async def stream():
        async for event in manager.ask(prompt):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.post("/api/reset")
async def reset():
    await manager.reset()
    return {"ok": True}


@app.exception_handler(tg.NotLoggedIn)
async def not_logged_in(_, exc):
    return JSONResponse({"error": str(exc)}, status_code=401)


if __name__ == "__main__":
    try:
        uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
    except tg.NotLoggedIn as exc:
        print(exc, file=sys.stderr)
        sys.exit(3)
