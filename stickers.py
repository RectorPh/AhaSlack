"""Your Telegram stickers, custom emoji and gifts, for the web app's picker.

Reads your sticker library (recent, favorites, installed sets), your custom emoji sets, the
gifts on your profile and Telegram's gift catalog. Sticker files are cached on disk.
Sending a sticker is the only write here, and only the user triggers it. Gifts cost Telegram
Stars, so this app shows them but never buys or sends one.
"""
from __future__ import annotations

import gzip
from datetime import timezone
from pathlib import Path

from telethon import types, utils
from telethon.tl.functions.messages import (GetAllStickersRequest, GetEmojiStickersRequest,
                                            GetFavedStickersRequest, GetRecentStickersRequest,
                                            GetStickerSetRequest)
from telethon.tl.functions.payments import GetSavedStarGiftsRequest, GetStarGiftsRequest

import tg

DOCS: dict[int, types.Document] = {}  # every sticker document we've seen, for downloads and sending
CACHE = tg.CACHE / "stickers"
FORMATS = {"image/webp": ("static", ".webp"), "application/x-tgsticker": ("animated", ".json"), "video/webm": ("video", ".webm")}
MIME = {".webp": "image/webp", ".json": "application/json", ".webm": "video/webm", ".jpg": "image/jpeg", ".png": "image/png"}


def doc_info(doc) -> dict | None:
    if not isinstance(doc, types.Document):
        return None
    DOCS[doc.id] = doc
    alt, w, h = "", 512, 512
    for a in doc.attributes:
        if isinstance(a, (types.DocumentAttributeSticker, types.DocumentAttributeCustomEmoji)):
            alt = a.alt or ""
        if isinstance(a, (types.DocumentAttributeImageSize, types.DocumentAttributeVideo)):
            w, h = a.w or w, a.h or h
    fmt = FORMATS.get(doc.mime_type, ("static", ".webp"))[0]
    return {"id": str(doc.id), "emoji": alt, "format": fmt, "w": w, "h": h, "has_thumb": bool(doc.thumbs)}


def set_info(s) -> dict:
    return {"id": str(s.id), "access_hash": str(s.access_hash), "title": s.title, "short_name": s.short_name,
            "count": s.count, "emoji": bool(getattr(s, "emojis", False))}


async def library(client) -> dict:
    allsets = await client(GetAllStickersRequest(hash=0))
    recent = await client(GetRecentStickersRequest(hash=0))
    faved = await client(GetFavedStickersRequest(hash=0))
    emoji = await client(GetEmojiStickersRequest(hash=0))
    pick = lambda docs: [i for i in (doc_info(d) for d in getattr(docs, "stickers", []) or []) if i]  # noqa: E731
    return {
        "recent": pick(recent)[:40],
        "faved": pick(faved),
        "sets": [set_info(s) for s in getattr(allsets, "sets", []) or []],
        "emoji_sets": [set_info(s) for s in getattr(emoji, "sets", []) or []],
    }


async def sticker_set(client, set_id: int, access_hash: int) -> list[dict]:
    res = await client(GetStickerSetRequest(stickerset=types.InputStickerSetID(id=set_id, access_hash=access_hash), hash=0))
    return [i for i in (doc_info(d) for d in res.documents) if i]


async def file_for(client, doc_id: int, thumb: bool) -> tuple[Path, str] | None:
    """The sticker (or its small preview) on disk: webp, Lottie JSON or webm."""
    doc = DOCS.get(doc_id)
    if doc is None:
        return None
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if thumb and doc.thumbs:
        path = CACHE / f"{doc_id}.thumb.webp"
        if not path.exists():
            data = await client.download_media(doc, file=bytes, thumb=-1)
            if not data:
                return None
            path.write_bytes(data)
        return path, "image/webp" if data_is_webp(path) else "image/jpeg"
    fmt, ext = FORMATS.get(doc.mime_type, ("static", ".webp"))
    path = CACHE / f"{doc_id}{ext}"
    if not path.exists():
        data = await client.download_media(doc, file=bytes)
        if not data:
            return None
        if fmt == "animated":  # .tgs is gzipped Lottie JSON
            data = gzip.decompress(data)
        path.write_bytes(data)
    return path, MIME[ext]


def data_is_webp(path: Path) -> bool:
    with path.open("rb") as f:
        head = f.read(12)
    return head[:4] == b"RIFF" and head[8:12] == b"WEBP"


async def send_sticker(client, cfg, chat: tg.Chat, doc_id: int) -> dict:
    doc = DOCS.get(doc_id)
    if doc is None:
        raise LookupError("unknown sticker; open the sticker picker again")
    msg = await client.send_file(chat.entity, doc)
    return tg.to_dict(msg, chat.entity, tg.ZoneInfo(cfg.timezone), tg.MAX_TEXT)


# ---------------------------------------------------------------- gifts (view only)

def _gift_doc(g) -> dict | None:
    if isinstance(g, types.StarGift):
        return doc_info(g.sticker)
    for a in getattr(g, "attributes", []) or []:  # unique (upgraded) gifts carry a model sticker
        if isinstance(a, types.StarGiftAttributeModel):
            return doc_info(a.document)
    return None


async def gifts(client) -> dict:
    saved = await client(GetSavedStarGiftsRequest(peer=types.InputPeerSelf(), offset="", limit=100))
    names = {utils.get_peer_id(e): utils.get_display_name(e) for e in [*saved.users, *saved.chats]}
    mine = []
    for s in saved.gifts:
        g = s.gift
        unique = isinstance(g, types.StarGiftUnique)
        mine.append({
            "title": f"{g.title} #{g.num}" if unique else "Gift",
            "stars": getattr(g, "stars", None),
            "from": names.get(utils.get_peer_id(s.from_id)) if s.from_id else ("Hidden" if s.name_hidden else None),
            "date": s.date.astimezone(timezone.utc).isoformat() if s.date else None,
            "message": getattr(s.message, "text", None),
            "unique": unique, "hidden": bool(s.unsaved), "doc": _gift_doc(g),
        })
    catalog = await client(GetStarGiftsRequest(hash=0))
    shop = [{"id": str(g.id), "stars": g.stars, "limited": bool(g.limited), "sold_out": bool(g.sold_out),
             "remains": g.availability_remains, "total": g.availability_total, "doc": _gift_doc(g)}
            for g in getattr(catalog, "gifts", []) or [] if isinstance(g, types.StarGift)]
    return {"count": saved.count, "mine": mine, "catalog": shop}
