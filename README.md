<div align="center">

# AhaSlack

**Your Telegram, organized like Slack.**<br>
Threads, a Mentions inbox, DMs kept apart from groups, a Calm Space for focus, and an AI
inbox manager. Runs on your Mac with your own Telegram login.

![macOS](https://img.shields.io/badge/macOS-desktop%20app-000?logo=apple)
![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-official%20user%20API-26A5E4?logo=telegram&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
  <img alt="AhaSlack: a Telegram group shown as a Slack channel, with a thread open on the right" src="docs/screenshots/hero.png" width="100%">
</picture>

<sub>Screenshots use the built-in demo mode: every person and message in them is made up.</sub>

</div>

---

## Why AhaSlack?

Telegram is great for talking and hard for keeping track. In a busy work account, the messages
that need you get buried under group chatter, replies scatter through the history, and every
group looks as urgent as your boss's DM. AhaSlack keeps Telegram as the network and adds the
parts of Slack that make a busy inbox manageable.

| | Telegram | AhaSlack |
|---|---|---|
| **Mentions & replies** | An @ badge per chat; scroll to find each one | One **Activity** inbox for every mention and reply to you, across all chats. Kept for good, read on view, badge always right |
| **Threads** | Replies are quotes in a long timeline | Replies are **grouped into threads** under the message they answer, with a *N replies* bar, and open in a side pane |
| **DMs vs groups** | One mixed list, sorted by time | **Needs you**, **Channels** and **Direct messages** sections; muted chats, channels and bots tucked away |
| **Calm Space** | — | Hide everything except the conversation you're in |
| **AI inbox manager** | — | Ask *"what needs me today?"* and get a prioritized answer with links (read-only) |

## Features that Telegram doesn't have

### 🔔 Mentions & replies: one inbox for everything addressed to you

<img alt="Mentions & replies view" src="docs/screenshots/mentions.png" width="100%">

- Every **@mention** of you and every **reply to your messages**, from all your chats, in one
  list, newest first, with the message you were replying to quoted underneath.
- **Nothing disappears.** The history is stored in a local database (`inbox.db`), not just the
  last few days.
- **Read on view, like Slack:** a mention counts as read after it has been on screen for a
  moment, and Telegram's @ badge for that message clears too. **Mark unread** to keep one
  around, or **Mark all as read**.
- Filter by **Unread**, **@ Mentions** or **↩ Replies**. Click any item to jump to it in its chat
  (or thread). Reply inline, or ask the Inbox Manager about it.

### 🧵 Threads: replies grouped under the message they answer

<img alt="Threads view" src="docs/screenshots/threads.png" width="100%">

- In a channel, replies fold under their parent message as a **"3 replies · Last reply 10:50"**
  bar with the participants' avatars, so the main timeline stays readable.
- Open a thread and it slides in on the right, with **its own message box**. What you send
  there is a normal Telegram reply, so it lands in the same thread for everyone else.
- The **Threads** view lists every thread you're in (you replied, or someone replied to you),
  with a badge for new replies, an **Unread** tab, **Mark as read / Mark unread** on each
  thread, and **Mark all as read**.
- Grouping is **rule-based** ([`static/thread-rules.js`](static/thread-rules.js)). Certain:
  Telegram's Reply links, except that a reply coming hours later starts a fresh thread, and a
  lone reply to an old message stays in the channel. Guessed (marked *AUTO*, one click moves it
  back, and the correction is remembered): someone's follow-up within a minute of their thread
  reply unless it's addressed to the group, and a short answer ("ok", "dạ", "đúng rồi", 👍) from
  someone in the thread. Guessing can be turned off. There's a hook ready for a small local
  model to classify messages into threads later.
- Prefer Telegram's way? Turn threads off in Preferences (**⌘,**) to show replies inline again.

### 💬 Direct messages kept apart from groups

The sidebar works like Slack's (see the screenshot at the top):

- **Needs you:** groups where someone mentioned you, replied to you or said your name.
- **Channels:** your groups. A group with **Topics** becomes a section, and each topic is its own
  `# channel` with its own unread count.
- **Direct messages:** one-to-one chats, with avatars.
- **Muted, channels & bots:** everything that can wait, collapsed.

Sort by priority, recent activity or A→Z, show only unreads, **⭐ star** what matters, and
**ignore** noisy groups. Your Telegram folders work like Slack workspaces.

### 🌙 Calm Space: just the conversation

<img alt="Calm Space: only the conversation is shown" src="docs/screenshots/calm.png" width="100%">

One click (or **⌘J**) hides the sidebar, the rail and every badge, leaving only the chat
you're in, so you can read and write without the rest of the inbox pulling at you.

### ✦ Inbox Manager: ask your inbox what matters

<img alt="Inbox Manager answering 'What needs me today?'" src="docs/screenshots/manager.png" width="100%">

Ask in plain words: *"What needs me today?"*, *"Who tagged me and what do they want?"*,
*"What did I miss in #Engineering?"*. It reads your chats and answers with priorities and
links into the app, and can draft replies for you to send. It runs on Claude through your
Claude Code login. **It can only read**: it has no tool that sends, edits or marks anything.

## And everything you'd expect from a Slack client

- **Live sync:** new messages, edits, deletes and read states arrive as they happen, with
  desktop notifications for DMs and mentions and an unread count on the Dock icon.
- **Reading like Slack:** start where you left off, a *New* divider, an unread banner,
  **⌥⌘U** to jump to the first unread, **Esc** to mark a chat read, **⇧Esc** for everything.
- **Search that knows who you talk to:** like Slack's quick switcher, ⌘K and search rank
  matches by *frecency* (how often and how recently you open, write in and call each chat),
  starting from Telegram's own "most used" list, and learn what you pick after typing
  something ("k" → the Khanh you always mean).
- **Search** messages, channels and people (**⌘G**; **⌘F** in this chat). **⌘K** jumps
  anywhere: chats, Telegram topics, Threads and the other views, and settings and commands
  ("dark", "jade", "mute", "calm", "upload"…), so you rarely need to open Preferences.
- **Messages:** reply, edit, delete, unsend (**⌘Z**), forward, pin, react, remind me, and upload
  or drag in files.
- **Stickers, emoji and gifts:** your own sticker sets, custom emoji, and animated (Lottie) and
  video stickers inline. Gifts are view-only.
- **Keyboard first:** Slack's full shortcut list, every one rebindable from **⌘/**.
- **Themes:** light, dark or follow your Mac; nine sidebar themes (Aubergine, Jade, Lagoon,
  Indigo, Ember, Forest, Graphite, Paper, Sand) or your own colors, in Preferences (**⌘,**).
- **Sounds:** a different sound for DMs, mentions and new thread replies (seven to choose
  from, with volume), synthesized in the app. The 🔔 in the top bar mutes them, for 30 minutes,
  an hour, until tomorrow or until you turn them back on (**⌘⌥⇧M**).
- **Telegram Topics as channels:** each topic gets its own messages, composer and mark-read.

<img alt="A Telegram topic shown as a Slack channel" src="docs/screenshots/topics.png" width="100%">

## Try it without a Telegram account

Start the server with `uv run --script server.py` and open <http://127.0.0.1:8765/?demo>. Demo mode fills the
app with a made-up team and never contacts Telegram. You can also open a specific screen:
`?demo=hero`, `mentions`, `threads`, `calm`, `manager` or `topics`. These are the screens in
the screenshots above.

## Getting started

Setting up takes about 10 minutes. You only do it once. On first launch, the app opens a
**setup guide** that walks you through installing uv and steps 3 to 6, and ticks each one off as you finish it
(you can reopen it any time from **Help → Setup Guide**). Here are the same steps written out.

### Step 1: Install the tools

| Tool | Why | How |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | runs AhaSlack's Python engine and fetches its packages | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| [Node.js](https://nodejs.org) 18+ | builds the Mac app (only needed once) | `brew install node`, or the installer from nodejs.org |
| git | downloads the code | comes with Xcode's command line tools: `xcode-select --install` |

### Step 2: Build and install the app

```bash
git clone https://github.com/RectorPh/AhaSlack.git
cd AhaSlack/electron
npm install
npm run dmg                          # builds dist/AhaSlack-1.0.0-arm64.dmg
open dist/AhaSlack-1.0.0-arm64.dmg   # then drag AhaSlack onto Applications
```

Open AhaSlack from Applications. The app isn't signed by Apple, so the first time macOS may say
it can't check the developer. If it does, **right-click the app → Open → Open**. You only do this once.

### Step 3: Get your Telegram API keys

Every app that reads your own Telegram account needs a pair of keys from Telegram: an
**api_id** (a number) and an **api_hash** (a long code). They're free and take two minutes:

1. Go to **<https://my.telegram.org>** and enter your phone number in international format,
   for example `+84 912 345 678`.
2. Telegram sends a confirmation code **to your Telegram app** (a message from "Telegram"),
   not by SMS. Type it in on the website.
3. Click **API development tools**.
4. Fill in **Create new application**. Only the first two fields matter:

   | Field | What to enter |
   |---|---|
   | App title | `AhaSlack` |
   | Short name | `ahaslack` (5 to 32 letters or numbers) |
   | URL | leave empty |
   | Platform | Desktop |
   | Description | leave empty |

5. Click **Create application**. The page now shows **App api_id** and **App api_hash**. Keep
   it open for the next step.

> **Keep the api_hash private.** Together with a login, it gives access to your account.
> AhaSlack stores it only on your Mac.

### Step 4: Log in to Telegram

In the setup guide, click **Log in with Terminal**. Without the app, run
`uv run --script login.py` in the AhaSlack folder. Terminal asks four things:

```text
api_id: 12345678                                  ← the number from step 3
api_hash (hidden):                                ← paste it; nothing shows as you type
Please enter your phone (or bot token): +84912345678
Please enter the code you received: 12345         ← sent to your Telegram app
Please enter your password:                       ← only if you use two-step verification
Logged in as Your Name (@yourhandle).
```

That's it. AhaSlack now shows up as a new device in Telegram → **Settings → Devices**, where
you can log it out at any time. Telegram also sends you a "new login" message; that's expected.
You type your code and password in Terminal, never in the app's window.

### Step 5: Make it yours

Logging in creates `~/.config/telegram-inbox/config.toml` (the setup guide has an
**Open config.toml** button). Edit a few lines:

```toml
my_keywords = ["Linh", "chị Linh", "linhtran"]    # names people use for you → "Needs you"
timezone = "Asia/Ho_Chi_Minh"
sending_enabled = true     # send, reply, react and edit from AhaSlack (off by default)
mark_read_enabled = true   # mark chats read on Telegram when you open them, like Slack
vip_users = ["@my_manager"]           # optional: people whose messages always matter
ignore_chats = ["Crypto signals"]     # optional: groups to treat as noise
```

@mentions and replies to you are found automatically; `my_keywords` catches the times people
write your name without tagging you. Save the file and reopen AhaSlack.

### Step 6 (optional): Turn on the Inbox Manager

The Inbox Manager uses [Claude Code](https://claude.com/claude-code) and your Claude Code login,
so no API key is needed. Install it, run `claude` once in Terminal to log in, and reopen AhaSlack.
Everything else works without it.

### Then: open AhaSlack

The first start downloads AhaSlack's Python packages (about 150 MB, mostly the Inbox Manager's
`claude-agent-sdk`). The setup guide starts that download in the background as soon as uv is
installed and shows its progress, so it's usually done by the time you've logged in. After that
it opens in seconds and stays in sync live.

### If something goes wrong

| Problem | Fix |
|---|---|
| my.telegram.org says **ERROR** when creating the app | Try a different short name, turn off any VPN or ad blocker, or try again later. It's a known quirk of that site. |
| The login code never arrives | It's sent to your **Telegram app**, in a message from "Telegram", not by SMS. Open Telegram on your phone or desktop. |
| "Telegram session expired or was revoked" | You (or Telegram) logged this device out. Open **Help → Setup Guide** and do step 4 again. |
| macOS says it **can't check the developer** | Right-click AhaSlack in Applications → **Open** → **Open**. |
| The app says its server didn't start | **Help → Server Log** shows why. Check that `uv` works in Terminal (`uv --version`). |
| Stuck on "Starting AhaSlack…" | The first start is downloading ~150 MB; the progress line shows what. On a slow connection give it a few minutes. If it stopped, **Help → Server Log** says why; opening AhaSlack again resumes the download. |
| You want to disconnect | `uv run --script login.py --logout`, or Telegram → Settings → Devices → end the AhaSlack session. |

## Other ways to run it

**Desktop app without a disk image:** `npm run install-app` (in `electron/`) builds the app and
copies it straight into Applications. If you open the app from anywhere else, it offers to
move itself there. The app starts its local server for you and stops it when you quit.
Server logs are in `~/Library/Logs/AhaSlack/`.

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
db.py            local database: Activity (mentions & replies) and threads you're in
tg.py            Telegram access: chats, threads, triage snapshot, mentions, search, actions
stickers.py      your stickers, custom emoji and gifts
triage.py        "needs you / worth a look / ignore" rules
agent.py         the Inbox Manager (Claude Agent SDK, read-only Telegram tools)
fetch_inbox.py   the command-line snapshot
static/          the app: app.js, threads.js, live.js, slack.js, picker.js, demo.js
electron/        the AhaSlack macOS app
```

## Safety & privacy

- **Your login never leaves your Mac.** `~/.config/telegram-inbox/inbox.session` is a full
  login to your Telegram account, so never share or commit it. To revoke it, run
  `uv run --script login.py --logout`, or go to Telegram → Settings → Devices.
- **No third-party server.** AhaSlack talks to Telegram directly with the official user API.
  Your messages are only sent anywhere else when you ask the Inbox Manager, which sends what it
  reads to Claude.
- **The server only listens on 127.0.0.1** and refuses requests from other websites (Host check,
  custom header, Origin check), so a web page can't use it to send messages as you.
- **Only you change Telegram.** Sending, editing, deleting, reacting and marking read happen only
  when you act in the app, and only if you turned them on in `config.toml`. Deleting asks first.
- **The Inbox Manager is read-only**, and treats message text as data, never as instructions.

## Tests

```bash
uv run --with pytest --with telethon python -m pytest tests
```

## License

MIT. Not affiliated with Slack or Telegram.
