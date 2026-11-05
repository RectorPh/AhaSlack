#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["telethon>=1.36"]
# ///
"""Read-only snapshot of your Telegram inbox, for the telegram-inbox skill.

    uv run --script fetch_inbox.py                 # everything still unread
    uv run --script fetch_inbox.py --hours 12      # all activity in the last 12h, read or not
    uv run --script fetch_inbox.py --chat "Fleet"  # deep dive into chats whose name matches

Writes ~/.cache/telegram-inbox/latest.json (full) and latest.txt (compact, for Claude),
then prints one summary line. It never sends messages and never marks anything as read.

Exit codes: 0 ok, 2 bad config, 3 not logged in (run login.py), 4 Telegram/network error.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import tg


async def run(args) -> dict:
    cfg = tg.load_config()
    client = tg.make_client()
    try:
        me = await tg.connect(client)
        chats = await tg.load_chats(client, cfg.include_archived or bool(args.chat))
        return await tg.snapshot(client, me, cfg, chats, hours=args.hours, chat_filter=args.chat,
                                 scan_override=args.scan, max_chats=args.max_chats)
    finally:
        await client.disconnect()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=float, help="look at all activity in the last N hours, read or not")
    ap.add_argument("--chat", help="only chats matching this name, @username or id (deep dive)")
    ap.add_argument("--scan", type=int, help="messages to read per chat in --chat mode")
    ap.add_argument("--max-chats", type=int, default=150)
    ap.add_argument("--out-dir", type=Path, default=tg.CACHE)
    args = ap.parse_args()

    try:
        report = asyncio.run(run(args))
    except tg.NotLoggedIn as exc:
        print(exc, file=sys.stderr)
        return 3
    except (TypeError, ValueError) as exc:
        print(f"Bad config in {tg.HOME / 'config.toml'}: {exc}", file=sys.stderr)
        return 2
    except (ConnectionError, OSError, asyncio.TimeoutError) as exc:
        print(f"Could not reach Telegram: {exc}", file=sys.stderr)
        return 4

    txt = tg.save_snapshot(report, args.out_dir)
    t = report["totals"]
    print(f"{t['chats']} chats, {t['unread']} unread → must {t['must']}, maybe {t['maybe']}, "
          f"noise {t['noise']} · {txt} ({txt.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
