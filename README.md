# AhaSlack

**A Slack-style desktop client for your Telegram, with an AI inbox manager.**

AhaSlack shows your own Telegram account the way Slack shows a workspace: channels and DMs
in a sidebar, threads, mentions, search, Slack's keyboard shortcuts, and a live connection,
so new messages appear the moment they're sent. An **Inbox Manager** (Claude) reads your chats
for you and tells you what needs you, who tagged you and what you can ignore.

> Not affiliated with Slack or Telegram. AhaSlack uses Telegram's official user API with your
> own login and runs entirely on your Mac; nothing goes to a third-party server.

## What you get

- **Live sync:** Telegram pushes new messages, edits, deletes and read states to the app as
  they happen, with desktop notifications for DMs and mentions and a Dock badge.
- **Triage:** a **Needs you** section for groups that mention you, reply to you or say your
  name; **Direct messages** for DMs; **Muted, channels & bots** for the rest. Right-click a
  group to **ignore** it, or **star** it into ⭐ Starred.
- **Slack-style sidebar:** sort by Priority, Recent activity or A→Z, show everything, only
  unreads, or only mentions and DMs. Your Telegram folders work like Slack workspaces.
- **Reading like Slack:** "start where I left off and mark read", "start at the newest", or
  "leave unread"; a *New* divider; an unread banner; **⌘J** to the first unread; **Esc** to
  mark a chat read and **⇧Esc** for everything.
- **Mentions & replies (Activity):** everywhere you were tagged or replied to. Click one to
  jump to it in its chat, reply inline, or mark it done (or **Mark all done**).
- **Search** messages, channels and people (**⌘G**, **⌘F** for this chat), and **⌘K** to
  jump anywhere.
- **Messages:** reply, edit, delete, unsend (⌘Z), forward, pin, react, remind me, upload or
  drag in files. Send stickers from your own sticker sets, Unicode and custom emoji, and see
  the gifts on your profile and the Telegram gift catalog.
- **Images and stickers inline:** photos, image files, static, animated (Lottie) and video
  stickers.
- **Keyboard:** Slack's whole shortcut list (all 77 rows of Slack's help page are covered or
  explained), rebindable from **⌘/**.
- **Calm Space** (⌘⌥C): hide everything but the conversation.
- **Inbox Manager:** ask in plain words ("what needs me today?", "what did I miss in #X?").
  It answers with links into the app and drafts replies. It can only **read** Telegram; it
  has no tool that sends, edits or marks anything.

## Requirements

- macOS (the desktop app; the web version runs anywhere Python does)
- [uv](https://docs.astral.sh/uv/) for Python: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- A Telegram account and an API id/hash from <https://my.telegram.org> → *API development tools*
- For the Inbox Manager: [Claude Code](https://claude.com/claude-code) installed and logged in
  (it uses your Claude Code login; no API key needed)
- To build the desktop app: Node.js 18+

## Set up

```bash
git clone https://github.com/RectorPh/AhaSlack.git && cd AhaSlack
uv run --script login.py          # api_id, api_hash, phone, the code Telegram sends, 2FA
```

Login stores everything in `~/.config/telegram-inbox/` (owner-only). It also creates
`~/.config/telegram-inbox/config.toml`: put your name and handle in `my_keywords`, your
timezone in `timezone`, and turn on `sending_enabled` / `mark_read_enabled` if you want to
send and mark read from the app (both are off by default).

## Run

**Desktop app (macOS):**

```bash
cd electron && npm install && npm run dist   # builds electron/dist/mac-arm64/AhaSlack.app
open dist/mac-arm64/AhaSlack.app
```

The app starts the local server for you and stops it when you quit. If you haven't logged in
yet, it opens Terminal to do it. The app is unsigned, so the first time, right-click it and
choose **Open**. Server logs are in `~/Library/Logs/AhaSlack/`.

**In a browser:**

```bash
uv run --script server.py         # then open http://127.0.0.1:8765
```

**Command line (no UI):** `uv run --script fetch_inbox.py` writes a triage snapshot to
`~/.cache/telegram-inbox/latest.txt`; `--hours 12` covers everything from the last 12 hours,
and `--chat "name"` focuses on one chat.

## How it fits together

```
login.py         one-time Telegram login (Telethon user API)
server.py        local web server (FastAPI, 127.0.0.1 only) + the page in static/
live.py          real-time sync: Telegram events -> in-memory state -> the page (SSE)
tg.py            Telegram access: chats, triage snapshot, mentions, search, message actions
stickers.py      your stickers, custom emoji and gifts
triage.py        "needs you / worth a look / ignore" rules (tested in tests/)
agent.py         the Inbox Manager (Claude Agent SDK, read-only Telegram tools)
fetch_inbox.py   the command-line snapshot
electron/        the AhaSlack macOS app
```

## Safety

- **Your login never leaves your Mac.** `~/.config/telegram-inbox/inbox.session` is a full
  login to your Telegram account, so never share or commit it. To revoke it, run
  `uv run --script login.py --logout`, or go to Telegram → Settings → Devices.
- **The server only listens on 127.0.0.1.** It refuses requests from other websites (Host
  check, custom header, Origin check), so a web page can't use it to send messages as you.
- **Only you can change Telegram.** Sending, editing, deleting, reacting and marking read
  happen only when you act in the app, and only if you turned them on in `config.toml`.
  Deleting asks first; gifts cost Telegram Stars, so the app only displays them.
- **The Inbox Manager is read-only**, and treats message text as data, never as
  instructions.

## Tests

```bash
python3 -m unittest discover -s tests
```

## License

MIT
