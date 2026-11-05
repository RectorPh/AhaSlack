#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["telethon>=1.36"]
# ///
"""One-time Telegram login for the inbox agent. Run it yourself in a terminal:

    uv run --script login.py            # log in (asks for api_id/api_hash, phone, code, 2FA)
    uv run --script login.py --logout   # end the session on Telegram's side and delete it

Get api_id and api_hash at https://my.telegram.org -> API development tools.
Everything is stored in ~/.config/telegram-inbox/ with owner-only permissions.
The session file is a full login to your account: never share or commit it.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import shutil
import sys
from pathlib import Path

from telethon import TelegramClient, utils

HOME = Path(os.environ.get("TG_INBOX_HOME", "~/.config/telegram-inbox")).expanduser()
CREDS = HOME / "credentials.json"
SESSION = HOME / "inbox"  # Telethon adds .session
EXAMPLE = Path(__file__).with_name("config.example.toml")


def lock_down() -> None:
    os.chmod(HOME, 0o700)
    for f in HOME.iterdir():
        if f.is_file():
            os.chmod(f, 0o600)


def read_creds() -> tuple[int, str]:
    if CREDS.exists():
        c = json.loads(CREDS.read_text())
        return int(c["api_id"]), c["api_hash"]
    print("Create an app at https://my.telegram.org -> API development tools, then paste its values.")
    api_id = int(input("api_id: ").strip())
    api_hash = getpass.getpass("api_hash (hidden): ").strip()
    CREDS.write_text(json.dumps({"api_id": api_id, "api_hash": api_hash}))
    return api_id, api_hash


async def login() -> None:
    api_id, api_hash = read_creds()
    client = TelegramClient(str(SESSION), api_id, api_hash)
    await client.start()  # prompts for phone number, login code and 2FA password
    me = await client.get_me()
    await client.disconnect()
    print(f"Logged in as {utils.get_display_name(me)} (@{me.username or '-'}).")


async def logout() -> None:
    if CREDS.exists() and Path(f"{SESSION}.session").exists():
        api_id, api_hash = read_creds()
        client = TelegramClient(str(SESSION), api_id, api_hash)
        await client.connect()
        if await client.is_user_authorized():
            await client.log_out()
        await client.disconnect()
    Path(f"{SESSION}.session").unlink(missing_ok=True)
    print("Logged out; session deleted. Your config.toml and api credentials were kept.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logout", action="store_true")
    args = ap.parse_args()
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.logout:
        asyncio.run(logout())
        return 0
    if not (HOME / "config.toml").exists() and EXAMPLE.exists():
        shutil.copy(EXAMPLE, HOME / "config.toml")
        print(f"Created {HOME / 'config.toml'}: edit it to add your name, VIPs and chats to ignore.")
    asyncio.run(login())
    lock_down()
    return 0


if __name__ == "__main__":
    sys.exit(main())
