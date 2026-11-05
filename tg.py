"""Telegram access shared by fetch_inbox.py (CLI) and server.py (web app).

Everything here is read-only except send_text(), which only the web app's composer calls
(when sending_enabled is on). Nothing edits, deletes, reacts or marks anything as read, and
the Inbox Manager agent has no tool that reaches send_text().
"""
from __future__ import annotations

import dataclasses
import gzip
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import tomllib
from telethon import TelegramClient, types, utils
from telethon.sessions import SQLiteSession, StringSession
from telethon.extensions import markdown as tmd
from telethon.tl.functions.account import UpdateProfileRequest
from telethon.tl.functions.messages import (GetDialogFiltersRequest, GetForumTopicsRequest,
                                            GetUnreadMentionsRequest, MarkDialogUnreadRequest,
                                            ReadDiscussionRequest, SendReactionRequest)
from telethon.tl.functions.users import GetFullUserRequest

import triage

HOME = Path(os.environ.get("TG_INBOX_HOME", "~/.config/telegram-inbox")).expanduser()
CACHE = Path(os.environ.get("TG_INBOX_CACHE", "~/.cache/telegram-inbox")).expanduser()
LOGIN_HINT = f"uv run --script \"{Path(__file__).with_name('login.py')}\""


class NotLoggedIn(RuntimeError):
    pass


def load_config() -> triage.Config:
    path = HOME / "config.toml"
    data = tomllib.loads(path.read_text("utf-8")) if path.exists() else {}
    return triage.Config.from_dict(data)


def make_client(in_memory: bool = False) -> TelegramClient:
    """in_memory=True copies the login into RAM so a long-running server doesn't
    hold the session file open (the CLI can still run alongside it)."""
    creds_file, session_file = HOME / "credentials.json", HOME / "inbox.session"
    if not creds_file.exists() or not session_file.exists():
        raise NotLoggedIn(f"Not logged in. Run in a terminal:\n  {LOGIN_HINT}")
    creds = json.loads(creds_file.read_text())
    if in_memory:
        disk = SQLiteSession(str(HOME / "inbox"))
        session = StringSession(StringSession.save(disk))
        disk.close()
    else:
        session = str(HOME / "inbox")
    return TelegramClient(session, int(creds["api_id"]), creds["api_hash"], flood_sleep_threshold=60)


async def connect(client: TelegramClient):
    await client.connect()
    if not await client.is_user_authorized():
        raise NotLoggedIn(f"Telegram session expired or was revoked. Run again:\n  {LOGIN_HINT}")
    return await client.get_me()


# ---------------------------------------------------------------- formatting

def uname(entity) -> str | None:
    if getattr(entity, "username", None):
        return entity.username
    for u in getattr(entity, "usernames", None) or []:
        if getattr(u, "active", True):
            return u.username
    return None


def chat_link(entity) -> str | None:
    u = uname(entity)
    if u:
        return f"https://t.me/{u}"
    if isinstance(entity, types.User):
        return f"tg://user?id={entity.id}"
    return None


def msg_link(entity, msg_id: int) -> str | None:
    """Only supergroups and channels have per-message links."""
    if not isinstance(entity, types.Channel):
        return None
    u = uname(entity)
    return f"https://t.me/{u}/{msg_id}" if u else f"https://t.me/c/{entity.id}/{msg_id}"


def chat_kind(d) -> str:
    e = d.entity
    if isinstance(e, types.User):
        return "bot" if e.bot else "dm"
    if d.is_group:
        return "group"
    return "channel" if d.is_channel else "group"


def is_muted(d, now: datetime) -> bool:
    ns = getattr(d.dialog, "notify_settings", None)
    until = getattr(ns, "mute_until", None)
    return bool(until and until > now)


def media_kind(m) -> str | None:
    if m.poll:
        q = m.poll.poll.question
        return f"poll: {getattr(q, 'text', q)}"
    for attr, label in (("voice", "voice"), ("video_note", "video note"), ("sticker", "sticker"),
                        ("gif", "gif"), ("photo", "photo"), ("video", "video"),
                        ("audio", "audio"), ("contact", "contact"), ("geo", "location")):
        if getattr(m, attr, None):
            return label
    if m.document:
        name = getattr(m.file, "name", None)
        return f"file: {name}" if name else "file"
    return None


# Every user/chat seen in a response, by marked peer id, so avatars can be downloaded later.
ENTITIES: dict[int, object] = {}


def photo_id(entity) -> int | None:
    """Id of the current profile photo, or None when there is none (or it is hidden)."""
    return getattr(getattr(entity, "photo", None), "photo_id", None)


def remember(entity) -> int:
    peer = utils.get_peer_id(entity)
    ENTITIES[peer] = entity
    return peer


def sender_info(m, chat_entity) -> dict:
    s = m.sender
    if s is None:  # anonymous admin or channel post: show the chat itself
        return {"id": None, "peer": remember(chat_entity), "photo": photo_id(chat_entity),
                "name": m.post_author or utils.get_display_name(chat_entity), "username": None, "bot": False}
    return {"id": s.id, "peer": remember(s), "photo": photo_id(s),
            "name": utils.get_display_name(s) or "?", "username": uname(s),
            "bot": bool(getattr(s, "bot", False))}


async def download_avatar(client, entity, out_dir: Path) -> Path | None:
    """Small (160px) profile photo, cached on disk per photo id."""
    pid = photo_id(entity)
    if not pid:
        return None
    path = out_dir / f"{utils.get_peer_id(entity)}_{pid}.jpg"
    if not path.exists():
        out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = await client.download_profile_photo(entity, file=bytes, download_big=False)
        if not data:
            return None
        path.write_bytes(data)
    return path


MAX_IMAGE_BYTES = 8_000_000


def image_info(m) -> dict | None:
    """What the web app can show inline: photos, image files, static stickers, video/GIF posters."""
    f = m.file
    if not f:
        return None
    dims = {"w": f.width or None, "h": f.height or None}
    if m.photo:
        return {"kind": "photo", **dims}
    doc = m.document
    if not doc:
        return None
    mime = f.mime_type or ""
    if m.sticker:
        kind = {"image/webp": "sticker", "application/x-tgsticker": "lottie", "video/webm": "vsticker"}.get(mime)
        return {"kind": kind, **dims} if kind else None
    if m.gif or m.video or m.video_note:
        return {"kind": "video", **dims} if getattr(doc, "thumbs", None) else None
    if mime.startswith("image/") and mime != "image/svg+xml" and (f.size or 0) <= MAX_IMAGE_BYTES:
        return {"kind": "image", **dims}
    return None


async def download_image(client, chat: "Chat", msg_id: int, out_dir: Path) -> tuple[Path, str] | None:
    """Fetch the picture of one message (or a video's poster frame), cached on disk."""
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for cached in out_dir.glob(f"{chat.id}_{msg_id}.*"):
        return cached, MIME_BY_EXT.get(cached.suffix, "application/octet-stream")
    m = await client.get_messages(chat.entity, ids=msg_id)
    info = image_info(m) if m else None
    if not info:
        return None
    if info["kind"] == "video":
        data, mime = await client.download_media(m, file=bytes, thumb=-1), "image/jpeg"
    elif info["kind"] == "lottie":  # animated sticker: gzipped Lottie JSON, served unzipped
        data, mime = gzip.decompress(await client.download_media(m, file=bytes) or b"") or None, "application/json"
    else:
        data, mime = await client.download_media(m, file=bytes), m.file.mime_type or "image/jpeg"
    if not data:
        return None
    ext = {v: k for k, v in MIME_BY_EXT.items()}.get(mime, ".bin")
    path = out_dir / f"{chat.id}_{msg_id}{ext}"
    path.write_bytes(data)
    return path, mime


MIME_BY_EXT = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
               ".json": "application/json", ".webm": "video/webm",
               ".heic": "image/heic", ".bmp": "image/bmp"}


def to_dict(m, entity, tz, text_chars: int, mine_reply_ids: set[int] | frozenset = frozenset()) -> dict:
    text = m.message or ""
    if text_chars and len(text) > text_chars:
        text = text[:text_chars] + "…"
    return {
        "id": m.id,
        "chat_id": utils.get_peer_id(entity),
        "topic_id": topic_of(m) if getattr(entity, "forum", False) else None,
        "image": image_info(m),
        "date": m.date.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
        "sender": sender_info(m, entity),
        "text": text,
        "out": bool(m.out),
        "mentioned": bool(m.mentioned),
        "reply_to_me": m.id in mine_reply_ids,
        "reply_to": reply_target(m),
        "media": media_kind(m),
        "forwarded": bool(m.fwd_from),
        "link": msg_link(entity, m.id),
        "pinned": bool(getattr(m, "pinned", False)),
        "edited": bool(getattr(m, "edit_date", None)) and not getattr(m, "edit_hide", False),
        "reactions": [{"emoji": getattr(r.reaction, "emoticon", None) or "★", "count": r.count,
                       "mine": r.chosen_order is not None}
                      for r in (getattr(getattr(m, "reactions", None), "results", None) or [])],
    }


GENERAL_TOPIC = 1  # a forum group's "General" topic; its messages carry no topic header


def topic_of(m) -> int:
    """The forum topic a message belongs to (Telegram Topics, shown as Slack channels)."""
    r = m.reply_to
    if isinstance(r, types.MessageReplyHeader) and r.forum_topic:
        return r.reply_to_top_id or r.reply_to_msg_id
    return GENERAL_TOPIC


def reply_target(m) -> int | None:
    r = m.reply_to
    if not isinstance(r, types.MessageReplyHeader) or not r.reply_to_msg_id:
        return None
    if r.reply_to_peer_id:          # reply to a message in another chat
        return None
    if r.forum_topic and not r.reply_to_top_id:  # just posted inside a topic, not a reply
        return None
    return r.reply_to_msg_id


async def my_reply_targets(client, entity, msgs) -> dict[int, object]:
    """{incoming message id: my message it replies to}"""
    wanted = {m.id: reply_target(m) for m in msgs if not m.out}
    targets = sorted({t for t in wanted.values() if t})
    mine: dict[int, object] = {}
    for i in range(0, len(targets), 100):
        got = await client.get_messages(entity, ids=targets[i:i + 100])
        mine |= {t.id: t for t in got if t is not None and t.out}
    return {mid: mine[t] for mid, t in wanted.items() if t in mine}


# ---------------------------------------------------------------- dialogs

@dataclass
class Chat:
    """One dialog, kept in memory so tools can resolve chats by name or id."""
    id: int
    name: str
    username: str | None
    kind: str
    muted: bool
    archived: bool
    pinned: bool
    date: datetime | None
    entity: object
    dialog: object
    forum: bool = False

    def info(self) -> dict:
        d = self.dialog
        return {
            "id": self.id, "name": self.name, "username": self.username, "kind": self.kind,
            "muted": self.muted, "archived": self.archived, "pinned": self.pinned,
            "unread_count": d.unread_count, "unread_mentions": d.unread_mentions_count,
            "unread_mark": bool(getattr(d.dialog, "unread_mark", False)),
            "link": chat_link(self.entity), "photo": photo_id(self.entity), "forum": self.forum,
            "last_ts": self.date.timestamp() if self.date else 0,
        }


async def load_chats(client, include_archived: bool) -> list[Chat]:
    now = datetime.now(timezone.utc)
    chats = []
    async for d in client.iter_dialogs(archived=None if include_archived else False):
        e = d.entity
        is_self = isinstance(e, types.User) and e.is_self
        remember(e)
        chats.append(Chat(id=d.id, name="Saved Messages" if is_self else (d.name or "?"),
                          username=uname(e), kind=chat_kind(d),
                          muted=is_muted(d, now), archived=bool(d.archived), pinned=bool(d.pinned),
                          date=d.date, entity=e, dialog=d, forum=bool(getattr(e, "forum", False))))
    return chats


def find_chats(chats: list[Chat], query: str | int) -> list[Chat]:
    q = str(query).strip()
    exact = [c for c in chats if str(c.id) == q or (c.username and q.lstrip("@").casefold() == c.username.casefold())]
    if exact:
        return exact
    return [c for c in chats if triage.match_any([q], title=c.name)]


# ---------------------------------------------------------------- snapshot

async def read_chat_window(client, d, scan: int, cutoff: datetime | None) -> list:
    msgs = []
    if cutoff:
        async for m in client.iter_messages(d.entity, limit=scan):
            if m.date < cutoff:
                break
            msgs.append(m)
    else:
        read_upto = getattr(d.dialog, "read_inbox_max_id", 0) or 0
        msgs = [m async for m in client.iter_messages(d.entity, limit=scan, min_id=read_upto)]

    # Mentions can sit far back in a busy group; fetch them directly so none are missed.
    if d.unread_mentions_count:
        res = await client(GetUnreadMentionsRequest(
            peer=d.input_entity, offset_id=0, add_offset=0,
            limit=min(d.unread_mentions_count, 50), max_id=0, min_id=0))
        have = {m.id for m in msgs}
        missing = [m.id for m in res.messages if m.id not in have]
        if missing:
            msgs += [m for m in await client.get_messages(d.entity, ids=missing) if m]
    return [m for m in msgs if not isinstance(m, types.MessageService)]


async def snapshot(client, me, cfg: triage.Config, chats: list[Chat], *, hours: float | None = None,
                   chat_filter: str | None = None, scan_override: int | None = None,
                   max_chats: int = 150) -> dict:
    tz = ZoneInfo(cfg.timezone)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours) if hours else None
    if chat_filter:  # deep dive: keep everything that was scanned
        cfg = dataclasses.replace(cfg)
        cfg.limit_must = cfg.limit_maybe = cfg.limit_noise = scan_override or max(cfg.scan, cfg.limit_must)

    picked = find_chats(chats, chat_filter) if chat_filter else chats
    entries = []
    for c in picked:
        d = c.dialog
        info = c.info()
        if cutoff:
            if not c.date or c.date < cutoff:
                continue
        elif not (d.unread_count or d.unread_mentions_count or info["unread_mark"] or chat_filter):
            continue

        if chat_filter:
            scan = scan_override or max(cfg.scan, cfg.limit_must)
        elif c.kind in ("channel", "bot") or c.archived:
            scan = cfg.limit_noise
        elif c.muted and cfg.treat_muted_as_noise:
            scan = cfg.scan_noise
        else:
            scan = cfg.scan
        raw = await read_chat_window(client, d, scan, cutoff)
        if chat_filter and not cutoff and not raw:  # nothing unread: show recent history instead
            raw = [m async for m in client.iter_messages(c.entity, limit=cfg.limit_must)
                   if not isinstance(m, types.MessageService)]
        mine = set(await my_reply_targets(client, c.entity, raw))
        entry = triage.process_chat(info, [to_dict(m, c.entity, tz, cfg.text_chars, mine) for m in raw], cfg)
        read_upto = getattr(d.dialog, "read_inbox_max_id", 0) or 0
        if entry["tier"] == triage.MUST and not cutoff and read_upto and cfg.context_before:
            ctx = await client.get_messages(c.entity, limit=cfg.context_before, offset_id=read_upto + 1)
            entry["context_before"] = [to_dict(m, c.entity, tz, cfg.text_chars) for m in reversed(ctx)
                                       if not isinstance(m, types.MessageService)]
        entries.append(entry)
        if len(entries) >= max_chats:
            break

    meta = {
        "generated_at": now.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z"),
        "mode": f"chat '{chat_filter}'" if chat_filter else (f"last {hours}h" if hours else "unread"),
        "timezone": cfg.timezone,
        "me": {"id": me.id, "name": utils.get_display_name(me), "username": uname(me)},
    }
    return triage.finalize(entries, meta)


def save_snapshot(report: dict, out_dir: Path = CACHE) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    js, txt = out_dir / "latest.json", out_dir / "latest.txt"
    js.write_text(json.dumps(report, ensure_ascii=False, indent=1), "utf-8")
    txt.write_text(triage.render_text(report), "utf-8")
    for f in (js, txt):
        os.chmod(f, 0o600)
    return txt


# ---------------------------------------------------------------- mentions, context, search

async def fetch_mentions(client, cfg: triage.Config, chats: list[Chat], days: float = 14,
                         per_chat: int = 50) -> list[dict]:
    """Every @mention of you and reply to your messages in groups active in the last `days`."""
    tz = ZoneInfo(cfg.timezone)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out: list[dict] = []
    for c in chats:
        if c.kind != "group" or not c.date or c.date < cutoff:
            continue
        if triage.match_any(cfg.ignore_chats, id=c.id, username=c.username, title=c.name):
            continue
        msgs = []
        async for m in client.iter_messages(c.entity, limit=per_chat,
                                            filter=types.InputMessagesFilterMyMentions()):
            if m.date < cutoff:
                break
            if not m.out and not isinstance(m, types.MessageService):
                msgs.append(m)
        if not msgs:
            continue
        mine = await my_reply_targets(client, c.entity, msgs)
        read_upto = getattr(c.dialog.dialog, "read_inbox_max_id", 0) or 0
        for m in msgs:
            item = to_dict(m, c.entity, tz, 4000, set(mine))
            target = mine.get(m.id)
            item.update({
                "key": f"{c.id}:{m.id}",
                "chat": {"id": c.id, "name": c.name, "muted": c.muted, "link": chat_link(c.entity),
                         "photo": photo_id(c.entity), "kind": c.kind},
                "kind": "reply" if target else "mention",
                "replying_to": (target.message or media_kind(target) or "")[:300] if target else None,
                "unread": m.id > read_upto,
                "ts": m.date.timestamp(),
            })
            out.append(item)
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


async def message_context(client, cfg: triage.Config, chat: Chat, msg_id: int,
                          before: int = 6, after: int = 4) -> dict:
    tz = ZoneInfo(cfg.timezone)
    e = chat.entity
    target = await client.get_messages(e, ids=msg_id)
    if target is None:
        raise LookupError(f"message {msg_id} not found in {chat.name}")
    older = await client.get_messages(e, limit=before, offset_id=msg_id)
    newer = [m async for m in client.iter_messages(e, limit=after, min_id=msg_id, reverse=True)]
    parent = None
    rt = reply_target(target)
    if rt:
        p = await client.get_messages(e, ids=rt)
        parent = to_dict(p, e, tz, 1500) if p else None
    conv = lambda ms: [to_dict(m, e, tz, 1500) for m in ms
                       if m and not isinstance(m, types.MessageService)]
    return {"chat": chat.info(), "message": to_dict(target, e, tz, 4000), "replying_to": parent,
            "before": conv(reversed(older)), "after": conv(newer)}


async def recent_messages(client, cfg: triage.Config, chat: Chat, limit: int = 40,
                          hours: float | None = None) -> list[dict]:
    tz = ZoneInfo(cfg.timezone)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours) if hours else None
    msgs = []
    async for m in client.iter_messages(chat.entity, limit=limit):
        if cutoff and m.date < cutoff:
            break
        if not isinstance(m, types.MessageService):
            msgs.append(m)
    mine = set(await my_reply_targets(client, chat.entity, msgs))
    return [to_dict(m, chat.entity, tz, 1500, mine) for m in reversed(msgs)]


async def chat_window(client, cfg: triage.Config, chat: Chat, *, limit: int = 60,
                      around: int | None = None, before: int | None = None, topic: int | None = None) -> dict:
    """A slice of a chat for the web app: the latest messages, the ones around a message
    (to jump to a mention or search hit), or older ones (scrolling up)."""
    tz = ZoneInfo(cfg.timezone)
    e = chat.entity
    if topic and chat.forum:
        return await _topic_window(client, cfg, chat, topic, limit=limit, around=around, before=before)
    newer = []
    if around:
        half = max(limit // 2, 10)
        older = await client.get_messages(e, limit=half, offset_id=around + 1)  # includes `around`
        newer = [m async for m in client.iter_messages(e, limit=half, min_id=around, reverse=True)]
        has_older, has_newer = len(older) == half, len(newer) == half
    else:
        older = await client.get_messages(e, limit=limit, offset_id=before or 0)
        has_older, has_newer = len(older) == limit, bool(before)
    raw = [m for m in [*reversed(older), *newer] if m and not isinstance(m, types.MessageService)]
    mine = set(await my_reply_targets(client, e, raw))
    return {"messages": [to_dict(m, e, tz, 4000, mine) for m in raw],
            "has_older": has_older, "has_newer": has_newer}


async def _topic_window(client, cfg, chat: Chat, topic: int, *, limit: int, around: int | None, before: int | None) -> dict:
    """Messages of one forum topic. Named topics are threads (reply_to=topic); General has no
    thread, so it's read from the whole group and filtered."""
    tz = ZoneInfo(cfg.timezone)
    e = chat.entity
    general = topic == GENERAL_TOPIC
    scope = {} if general else {"reply_to": topic}
    keep = (lambda m: topic_of(m) == GENERAL_TOPIC) if general else (lambda m: True)
    want = limit * (4 if general else 1)  # General shares the group's history with every topic
    newer = []
    if around:
        half = max(limit // 2, 10)
        older = [m async for m in client.iter_messages(e, limit=want // 2 + 1, offset_id=around + 1, **scope)]
        newer = [m async for m in client.iter_messages(e, limit=want // 2, min_id=around, reverse=True, **scope)]
        has_older, has_newer = len(older) > half, len(newer) >= half
    else:
        older = [m async for m in client.iter_messages(e, limit=want, offset_id=before or 0, **scope)]
        has_older, has_newer = len(older) >= want, bool(before)
    raw = [m for m in [*reversed(older), *newer] if m and not isinstance(m, types.MessageService) and keep(m)]
    if not around:
        raw = raw[-limit:]
    mine = set(await my_reply_targets(client, e, raw))
    return {"messages": [to_dict(m, e, tz, 4000, mine) for m in raw], "has_older": has_older, "has_newer": has_newer}


async def forum_topics(client, chat: Chat) -> list[dict]:
    """The topics of a forum group, with their own unread and mention counts."""
    out, offset_date, offset_id, offset_topic = [], None, 0, 0
    for _ in range(5):  # up to 500 topics
        r = await client(GetForumTopicsRequest(peer=chat.entity, offset_date=offset_date, offset_id=offset_id,
                                               offset_topic=offset_topic, limit=100))
        dates = {m.id: m.date for m in r.messages}
        batch = [t for t in r.topics if isinstance(t, types.ForumTopic)]
        for t in batch:
            last = dates.get(t.top_message) or t.date
            out.append({"id": t.id, "title": t.title, "unread_count": t.unread_count,
                        "unread_mentions": t.unread_mentions_count, "read_upto": t.read_inbox_max_id,
                        "top_message": t.top_message, "last_ts": last.timestamp() if last else 0,
                        "closed": bool(t.closed), "pinned": bool(t.pinned), "hidden": bool(t.hidden)})
        if len(r.topics) < 100 or not batch:
            break
        tail = batch[-1]
        offset_topic, offset_id = tail.id, tail.top_message
        offset_date = dates.get(tail.top_message) or tail.date
    return out


async def read_mentions(client, chat: Chat, msg_ids: list[int]) -> None:
    """Clear Telegram's @-mention mark on these messages only (Slack: you saw the mention),
    without marking the rest of the chat read."""
    from telethon.tl.functions import channels as fch, messages as fms
    if isinstance(chat.entity, types.Channel):
        await client(fch.ReadMessageContentsRequest(channel=chat.entity, id=msg_ids))
    else:
        await client(fms.ReadMessageContentsRequest(id=msg_ids))
    d = chat.dialog
    d.unread_mentions_count = max(0, (d.unread_mentions_count or 0) - len(msg_ids))


async def read_topic(client, chat: Chat, topic: int, max_id: int) -> None:
    """Mark one topic read (Esc in a topic, like Slack marking one channel read)."""
    await client(ReadDiscussionRequest(peer=chat.entity, msg_id=topic, read_max_id=max_id))


MAX_TEXT = 4096  # Telegram's limit for one text message


class ComposerMarkdown:
    """Telegram markdown as the composer writes it (**bold**, __italic__, ~~strike~~, `code`,
    ```block```, [text](url)) plus ++underline++ for Slack's ⌘U."""
    DELIMITERS = {**tmd.DEFAULT_DELIMITERS, "++": types.MessageEntityUnderline}

    @staticmethod
    def parse(text):
        text, entities = tmd.parse(text, delimiters=ComposerMarkdown.DELIMITERS)
        # [😀](emoji/123) from the emoji picker becomes a Telegram custom emoji (needs Premium to show)
        out = []
        for e in entities:
            url = getattr(e, "url", "") or ""
            if isinstance(e, types.MessageEntityTextUrl) and url.startswith("emoji/") and url[6:].isdigit():
                out.append(types.MessageEntityCustomEmoji(offset=e.offset, length=e.length, document_id=int(url[6:])))
            else:
                out.append(e)
        return text, out

    @staticmethod
    def unparse(text, entities):
        return tmd.unparse(text, entities, delimiters=ComposerMarkdown.DELIMITERS)


async def send_text(client, cfg: triage.Config, chat: Chat, text: str, reply_to: int | None = None) -> dict:
    """Send one text message as the user. Only called from the web app's composer."""
    msg = await client.send_message(chat.entity, text, reply_to=reply_to, parse_mode=ComposerMarkdown)
    return to_dict(msg, chat.entity, ZoneInfo(cfg.timezone), MAX_TEXT)


async def mark_unread(client, chat: Chat) -> None:
    """Slack's ⌥-click / U: Telegram can only mark a whole chat unread, so that's what happens."""
    peer = types.InputDialogPeer(await client.get_input_entity(chat.entity))
    await client(MarkDialogUnreadRequest(peer=peer, unread=True))
    chat.dialog.dialog.unread_mark = True


async def save_to_saved(client, chat: Chat, msg_id: int) -> None:
    """Slack's "save a message" (A): forward it to your Saved Messages."""
    await client.forward_messages("me", msg_id, from_peer=chat.entity)


# ---------------------------------------------------------------- message actions (Slack's E, Delete, F, P, R, M, ⌘Z, ⌘O)
# Every one of these is only ever triggered by the user in the web app, never by the agent.

async def edit_text(client, cfg: triage.Config, chat: Chat, msg_id: int, text: str) -> dict:
    msg = await client.edit_message(chat.entity, msg_id, text, parse_mode=ComposerMarkdown)
    return to_dict(msg, chat.entity, ZoneInfo(cfg.timezone), MAX_TEXT)


async def delete_own(client, chat: Chat, msg_id: int) -> None:
    """Delete (or unsend) a message the user sent, for everyone."""
    m = await client.get_messages(chat.entity, ids=msg_id)
    if not m or not m.out:
        raise PermissionError("you can only delete your own messages here")
    await client.delete_messages(chat.entity, [msg_id], revoke=True)


async def forward_to(client, src: Chat, msg_id: int, dst: Chat) -> None:
    await client.forward_messages(dst.entity, msg_id, from_peer=src.entity)


async def set_pinned(client, chat: Chat, msg_id: int, pinned: bool) -> None:
    if pinned:
        await client.pin_message(chat.entity, msg_id, notify=False)
    else:
        await client.unpin_message(chat.entity, msg_id)


async def react(client, chat: Chat, msg_id: int, emoji: str | None) -> None:
    """Add (or with None, remove) your reaction."""
    reaction = [types.ReactionEmoji(emoticon=emoji)] if emoji else []
    await client(SendReactionRequest(peer=chat.entity, msg_id=msg_id, reaction=reaction))


async def remind(client, cfg: triage.Config, chat: Chat, msg_id: int, minutes: int) -> datetime:
    """Slack's reminder (M): a scheduled message to your Saved Messages, Telegram's own reminders."""
    m = await client.get_messages(chat.entity, ids=msg_id)
    when = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    who = "you" if m and m.out else (utils.get_display_name(m.sender) if m and m.sender else chat.name)
    text = f"⏰ Reminder · {chat.name}\n{who}: {(m.message or media_kind(m) or '') if m else ''}"[:3500]
    link = msg_link(chat.entity, msg_id)
    await client.send_message("me", text + (f"\n{link}" if link else ""), schedule=when, link_preview=False)
    return when


async def send_upload(client, cfg: triage.Config, chat: Chat, data: bytes, filename: str, caption: str = "",
                      reply_to: int | None = None) -> dict:
    import io
    f = io.BytesIO(data)
    f.name = filename
    msg = await client.send_file(chat.entity, f, caption=caption or None, parse_mode=ComposerMarkdown, reply_to=reply_to)
    return to_dict(msg, chat.entity, ZoneInfo(cfg.timezone), MAX_TEXT)


async def get_bio(client) -> str:
    full = await client(GetFullUserRequest("me"))
    return full.full_user.about or ""


async def set_bio(client, about: str) -> None:
    """Slack's "set your status" (⌘⇧Y): the closest Telegram has is your bio."""
    await client(UpdateProfileRequest(about=about))


# ---------------------------------------------------------------- folders (Slack's workspaces)

def _peer_key(p) -> int | None:
    try:
        return utils.get_peer_id(p)
    except Exception:  # noqa: BLE001
        return None


async def folders(client, chats: list[Chat]) -> list[dict]:
    """Telegram chat folders, each with the chat ids it contains (the app treats them like
    Slack workspaces: ⌘⇧S, Ctrl+Tab, ⌘1…9)."""
    res = await client(GetDialogFiltersRequest())
    filters = getattr(res, "filters", res)
    out = [{"id": 0, "title": "All chats", "emoji": "", "chats": [c.id for c in chats]}]
    for f in filters:
        if isinstance(f, types.DialogFilterDefault):
            continue
        title = getattr(f.title, "text", f.title)
        include = {_peer_key(p) for p in f.include_peers} | {_peer_key(p) for p in f.pinned_peers}
        exclude = {_peer_key(p) for p in getattr(f, "exclude_peers", [])}
        ids = []
        for c in chats:
            if c.id in exclude:
                continue
            ok = c.id in include
            if not ok and isinstance(f, types.DialogFilter):
                e = c.entity
                is_user = isinstance(e, types.User)
                ok = ((f.contacts and is_user and not e.bot and bool(e.contact))
                      or (f.non_contacts and is_user and not e.bot and not e.contact)
                      or (f.groups and c.kind == "group")
                      or (f.broadcasts and c.kind == "channel")
                      or (f.bots and c.kind == "bot"))
                if ok and ((f.exclude_muted and c.muted) or (f.exclude_archived and c.archived)
                           or (f.exclude_read and not c.dialog.unread_count and not c.dialog.unread_mentions_count)):
                    ok = False
            if ok:
                ids.append(c.id)
        out.append({"id": f.id, "title": title, "emoji": getattr(f, "emoticon", None) or "", "chats": ids})
    return out


async def search(client, cfg: triage.Config, query: str, chat: Chat | None = None,
                 days: float | None = None, limit: int = 30) -> list[dict]:
    tz = ZoneInfo(cfg.timezone)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    out = []
    async for m in client.iter_messages(chat.entity if chat else None, search=query, limit=limit):
        if cutoff and m.date < cutoff:
            break
        if isinstance(m, types.MessageService):
            continue
        ent = chat.entity if chat else (m.chat or await m.get_chat())
        item = to_dict(m, ent, tz, 600)
        item["chat"] = {"id": m.chat_id, "name": utils.get_display_name(ent) if ent else "?",
                        "photo": photo_id(ent), "kind": "dm" if isinstance(ent, types.User) else "group"}
        if ent:
            remember(ent)
        out.append(item)
    return out
