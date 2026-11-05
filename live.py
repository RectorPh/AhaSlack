"""Real-time sync: Telegram pushes updates to this process, and the page gets them over
Server-Sent Events (GET /api/events). No more rescans to see new messages.

Telegram -> Telethon event handlers -> in-memory state (unread counts, "needs you",
mentions) -> every open page. Read-only: nothing here sends or marks anything.
"""
from __future__ import annotations

import asyncio
import sys
import time
from zoneinfo import ZoneInfo

from telethon import events, types

import tg
import triage


class Live:
    def __init__(self, inbox):
        self.inbox = inbox
        self.subscribers: set[asyncio.Queue] = set()
        # chat id -> (tier, reasons) learned from live messages; wins over the last full scan
        self.tiers: dict[int, tuple[str, list[str]]] = {}
        self.last_event = 0.0
        self.started = time.time()
        self._reloading = False

    # ------------------------------------------------------------- fan-out to pages
    def publish(self, event: dict) -> None:
        self.last_event = time.time()
        for q in list(self.subscribers):
            if q.qsize() < 1000:  # a stuck tab must not grow memory forever
                q.put_nowait(event)

    async def stream(self):
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers.add(q)
        try:
            yield {"type": "hello", "connected": self.inbox.client.is_connected()}
            while True:
                try:
                    yield await asyncio.wait_for(q.get(), 25)
                except asyncio.TimeoutError:
                    yield {"type": "ping", "connected": self.inbox.client.is_connected()}
        finally:
            self.subscribers.discard(q)

    # ------------------------------------------------------------- Telegram side
    def attach(self) -> None:
        c = self.inbox.client
        c.add_event_handler(self._guard(self.on_new), events.NewMessage())
        c.add_event_handler(self._guard(self.on_edit), events.MessageEdited())
        c.add_event_handler(self._guard(self.on_delete), events.MessageDeleted())
        c.add_event_handler(self._guard(self.on_read), events.MessageRead(inbox=True))
        c.add_event_handler(self._guard(self.on_seen), events.MessageRead(inbox=False))
        c.add_event_handler(self._guard(self.on_topic_read), events.Raw(types.UpdateReadChannelDiscussionInbox))
        asyncio.create_task(self._catch_up())

    async def _catch_up(self) -> None:
        """Fetch what arrived while we were offline, then keep receiving live."""
        try:
            await self.inbox.client.catch_up()
        except Exception as exc:  # noqa: BLE001 - live updates still flow without it
            print(f"catch_up failed: {exc}", file=sys.stderr)

    def _guard(self, handler):
        async def run(event):
            try:
                await handler(event)
            except Exception as exc:  # noqa: BLE001 - one bad update must not stop the stream
                print(f"live update failed ({handler.__name__}): {type(exc).__name__}: {exc}", file=sys.stderr)
        return run

    async def _chat(self, chat_id: int | None) -> tg.Chat | None:
        c = self.inbox.chat_by_id(chat_id) if chat_id is not None else None
        if c is None and chat_id is not None and not self._reloading:
            self._reloading = True  # a brand-new conversation: refresh the dialog list once
            try:
                self.inbox.chats = await tg.load_chats(self.inbox.client, self.inbox.cfg.include_archived)
            finally:
                self._reloading = False
            c = self.inbox.chat_by_id(chat_id)
        return c

    def _ignored(self, chat: tg.Chat) -> bool:
        cfg = self.inbox.cfg
        return chat.id in self.inbox.ignored or bool(
            triage.match_any(cfg.ignore_chats, id=chat.id, username=chat.username, title=chat.name))

    async def on_new(self, event) -> None:
        m = event.message
        chat = await self._chat(event.chat_id)
        if chat is None or isinstance(m, types.MessageService):
            return
        cfg = self.inbox.cfg
        if m.sender is None and not m.out:
            await m.get_sender()
        mine = await tg.my_reply_targets(self.inbox.client, chat.entity, [m]) if not m.out else {}
        msg = tg.to_dict(m, chat.entity, ZoneInfo(cfg.timezone), 4000, set(mine))
        msg["flags"] = triage.message_flags(msg, cfg)

        d = chat.dialog
        d.message, d.date, chat.date = m, m.date, m.date
        if not m.out:
            d.unread_count = (d.unread_count or 0) + 1
            if m.mentioned:
                d.unread_mentions_count = (d.unread_mentions_count or 0) + 1

        topic = None
        if chat.forum:  # count it on its topic, like a Slack channel
            topic = self.inbox.topic(chat.id, msg.get("topic_id"))
            if topic is None:
                asyncio.create_task(self.inbox.load_topics(chat))  # a brand-new topic
            else:
                topic["last_ts"] = m.date.timestamp()
                topic["top_message"] = max(topic["top_message"], m.id)
                if not m.out:
                    topic["unread_count"] += 1
                    if m.mentioned:
                        topic["unread_mentions"] += 1

        ignored = self._ignored(chat)
        strong = triage.is_strong(msg["flags"])
        if not m.out and not ignored and (chat.kind == "dm" or strong):
            reasons = ["direct message"] if chat.kind == "dm" else []
            reasons += [{"reply_to_me": "replied to you", "mention": "@mentioned you", "vip_sender": "VIP sender"}.get(
                f, f"says '{f.split(':', 1)[-1]}'") for f in msg["flags"] if f.split(":")[0] in triage.STRONG_FLAGS]
            self.tiers[chat.id] = ("must", reasons or ["new message"])

        thread = self.inbox.track_thread(chat, msg | {"ts": m.date.timestamp()})  # threads you're in

        is_mention = chat.kind == "group" and not m.out and ("mention" in msg["flags"] or "reply_to_me" in msg["flags"])
        if is_mention and not ignored:
            target = mine.get(m.id)
            item = msg | {
                "key": f"{chat.id}:{m.id}",
                "chat": {"id": chat.id, "name": chat.name, "muted": chat.muted, "link": tg.chat_link(chat.entity),
                         "photo": tg.photo_id(chat.entity), "kind": chat.kind},
                "kind": "reply" if target else "mention",
                "replying_to": (target.message or tg.media_kind(target) or "")[:300] if target else None,
                "unread": True, "ts": m.date.timestamp(), "topic": topic and topic["title"],
            }
            self.inbox.mentions.insert(0, item)
            self.inbox.db.upsert([item])  # kept in Activity for good

        # Desktop notification, like Slack's default: DMs and mentions, never your own or ignored chats.
        notify = not m.out and not ignored and (is_mention or (chat.kind == "dm" and not chat.muted))
        tier, reasons = self.tiers.get(chat.id, (None, []))
        self.publish({"type": "message", "chat": chat.info() | {"tier": tier, "why": "; ".join(reasons), "ignored": chat.id in self.inbox.ignored},
                      "message": msg, "notify": notify, "mention": is_mention, "thread": thread,
                      "topic": topic and {k: topic[k] for k in ("id", "title", "unread_count", "unread_mentions", "last_ts")}})

    async def on_edit(self, event) -> None:
        chat = await self._chat(event.chat_id)
        if chat is None:
            return
        cfg = self.inbox.cfg
        msg = tg.to_dict(event.message, chat.entity, ZoneInfo(cfg.timezone), 4000)
        msg["flags"] = triage.message_flags(msg, cfg)
        self.publish({"type": "edit", "chat_id": chat.id, "message": msg})

    async def on_delete(self, event) -> None:
        # chat_id is only known for channels/supergroups; elsewhere ids are account-wide
        self.publish({"type": "delete", "chat_id": event.chat_id, "ids": list(event.deleted_ids)})

    async def on_read(self, event) -> None:
        """You read a chat somewhere else (phone, Telegram Desktop): clear it here too."""
        chat = self.inbox.chat_by_id(event.chat_id)
        if chat is None:
            return
        d = chat.dialog
        d.dialog.read_inbox_max_id = max(d.dialog.read_inbox_max_id or 0, event.max_id or 0)
        last = getattr(d.message, "id", 0) or 0
        if (event.max_id or 0) >= last:
            d.unread_count = d.unread_mentions_count = 0
            self.tiers.pop(chat.id, None)
        for m in self.inbox.mentions:
            if m["chat"]["id"] == chat.id and m["id"] <= (event.max_id or 0):
                m["unread"] = False
        cleared = self.inbox.db.mark_chat_read(chat.id, event.max_id or 0)
        self.publish({"type": "read", "chat_id": chat.id, "max_id": event.max_id, "unread": d.unread_count,
                      "mentions_read": cleared, "mentions_unread": self.inbox.db.unread_count(self.inbox.ignored)})

    async def on_topic_read(self, update) -> None:
        """You read a topic somewhere else: clear it here too."""
        chat_id = int(f"-100{update.channel_id}")
        t = self.inbox.topic(chat_id, update.top_msg_id)
        if t is None:
            return
        t["read_upto"] = max(t["read_upto"], update.read_max_id)
        if update.read_max_id >= t["top_message"]:
            t["unread_count"] = t["unread_mentions"] = 0
        cleared = self.inbox.db.mark_chat_read(chat_id, update.read_max_id, update.top_msg_id)
        self.publish({"type": "topic_read", "chat_id": chat_id, "topic_id": update.top_msg_id, "unread": t["unread_count"],
                      "mentions_read": cleared, "mentions_unread": self.inbox.db.unread_count(self.inbox.ignored)})

    async def on_seen(self, event) -> None:
        """Someone read your messages (Telegram's ✓✓)."""
        self.publish({"type": "seen", "chat_id": event.chat_id, "max_id": event.max_id})
