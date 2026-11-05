"use strict";
// Demo mode: open http://127.0.0.1:8765/?demo to see AhaSlack with made-up chats and people.
// Nothing here talks to Telegram: every /api call is answered in the page. Used for the README
// screenshots (?demo=hero, mentions, threads, calm, manager, topics) and to try the UI safely.
(() => {
  const shot = new URLSearchParams(location.search).get("demo") || "";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const at = (daysAgo, hh, mm) => {
    const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(hh, mm, 0, 0);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh)}:${pad(mm)}`, ts: d.getTime() / 1000 };
  };
  const ME = { name: "Alex Morgan", username: "alexm", peer: 1, photo: null };
  const P = {};
  for (const [id, name] of [[201, "Linh Tran"], [202, "Marco Rossi"], [203, "Aisha Khan"], [204, "Sam Okafor"], [205, "Yuki Tanaka"],
    [206, "Priya Nair"], [207, "Diego Alvarez"], [208, "Hana Kim"], [209, "Deploy Bot"]]) P[id] = { id, peer: id, photo: null, name, username: null, bot: id === 209 };

  const chat = (id, name, kind, o = {}) => ({ id, name, username: null, kind, muted: false, archived: false, pinned: false, unread_count: 0,
    unread_mentions: 0, unread_mark: false, photo: null, last_ts: now / 1000 - 3600, link: null, forum: false, tier: "maybe", why: "", ignored: false, ...o });
  const CHATS = [
    chat(-1001, "Product Squad", "group", { unread_count: 6, unread_mentions: 1, tier: "must", why: "@mentioned you; replied to you", last_ts: now / 1000 - 300 }),
    chat(101, "Linh Tran", "dm", { unread_count: 2, tier: "must", why: "direct message; urgent word: asap", last_ts: now / 1000 - 600 }),
    chat(-1002, "Ops Center", "group", { unread_count: 9, forum: true, last_ts: now / 1000 - 900 }),
    chat(-1003, "Design Crit", "group", { unread_count: 3, last_ts: now / 1000 - 4000 }),
    chat(-1004, "Engineering", "group", { unread_count: 17, last_ts: now / 1000 - 1800 }),
    chat(103, "Aisha Khan", "dm", { unread_count: 1, tier: "must", why: "direct message", last_ts: now / 1000 - 2400 }),
    chat(102, "Marco Rossi", "dm", { last_ts: now / 1000 - 9000 }),
    chat(104, "Sam Okafor", "dm", { last_ts: now / 1000 - 86400 }),
    chat(-1005, "Partner Integrations", "group", { last_ts: now / 1000 - 7200 }),
    chat(109, "Deploy Bot", "bot", { unread_count: 4, tier: "noise", last_ts: now / 1000 - 1200 }),
    chat(-1006, "Company Announcements", "group", { unread_count: 2, muted: true, tier: "noise", last_ts: now / 1000 - 30000 }),
    chat(-1007, "Weekend Football ⚽", "group", { unread_count: 143, muted: true, tier: "noise", last_ts: now / 1000 - 5000 }),
  ];
  const TOPICS = { "-1002": [
    { id: 1, title: "General", unread_count: 0, unread_mentions: 0, read_upto: 0, top_message: 1, last_ts: now / 1000 - 9000, closed: false, pinned: true, hidden: false },
    { id: 10, title: "Dispatch", unread_count: 5, unread_mentions: 0, read_upto: 0, top_message: 10, last_ts: now / 1000 - 900, closed: false, pinned: false, hidden: false },
    { id: 20, title: "Incidents", unread_count: 4, unread_mentions: 0, read_upto: 0, top_message: 20, last_ts: now / 1000 - 1500, closed: false, pinned: false, hidden: false },
    { id: 30, title: "Weekly Review", unread_count: 0, unread_mentions: 0, read_upto: 0, top_message: 30, last_ts: now / 1000 - 90000, closed: false, pinned: false, hidden: false },
  ] };

  // Messages: [id, who (peer id or "me"), day, hh, mm, text, extra]
  const MSGS = {};
  function build(chatId, rows) {
    MSGS[chatId] = rows.map(([id, who, day, hh, mm, text, x = {}]) => {
      const t = at(day, hh, mm);
      const out = who === "me";
      const m = { id, chat_id: chatId, topic_id: x.topic ?? null, image: null, date: t.date, ts: t.ts, sender: out ? { ...ME, id: 1, bot: false } : P[who],
        text, out, mentioned: !!x.mention, reply_to_me: !!x.toMe, reply_to: x.reply ?? null, thread_top: x.reply ?? null, reply_count: 0, media: null,
        forwarded: !!x.fwd, fwd: x.fwd ? { name: P[x.fwd].name, peer: x.fwd, photo: null, date: t.date } : null, link: null, pinned: !!x.pinned, edited: false, reactions: x.r || [], flags: [...(x.mention ? ["mention"] : []), ...(x.toMe ? ["reply_to_me"] : []), ...(out ? ["from_me"] : [])] };
      return m;
    });
    for (const m of MSGS[chatId]) if (m.reply_to) m.thread_top = rootOf(chatId, m.reply_to);
  }
  function rootOf(chatId, id) {
    const m = MSGS[chatId].find((x) => x.id === id);
    return m && m.reply_to ? rootOf(chatId, m.reply_to) : id;
  }
  build(-1001, [
    [1, 202, 1, 16, 5, "Draft of the Q1 roadmap is in the doc. Biggest open question: do we ship offline mode before the partner API?", { r: [{ emoji: "👀", count: 3, mine: false }] }],
    [2, 203, 1, 16, 12, "Partner API first. Three partners are blocked on it and it unlocks revenue.", { reply: 1 }],
    [3, "me", 1, 16, 20, "Agree with Aisha. Offline mode can be the first thing in Q2.", { reply: 1 }],
    [4, 202, 1, 16, 31, "Ok, I'll reorder it and share the final version Monday.", { reply: 3 }],
    [5, 205, 0, 9, 2, "Morning all ☀️ Standup notes are pinned. Two things today: release 4.2 and the pricing experiment.", { pinned: true, r: [{ emoji: "🙌", count: 4, mine: true }] }],
    [6, 206, 0, 9, 40, "Release 4.2 is on staging. QA found one bug in the checkout flow, fix is in review."],
    [7, 207, 0, 9, 52, "Which bug? The tip amount rounding one?", { reply: 6 }],
    [8, 206, 0, 9, 55, "Yes, that one. Should be merged within the hour.", { reply: 7 }],
    [9, 206, 0, 9, 56, "I'll post here when it's out."],
    [10, 208, 0, 10, 15, "@alexm can you approve the copy for the pricing experiment? Need it before 2pm so it goes out with 4.2.", { mention: true }],
    [11, 203, 0, 10, 30, "Heads up: partner sync moved to 3pm today.", { r: [{ emoji: "👍", count: 5, mine: false }] }],
    [12, 208, 0, 10, 41, "Here's the copy: \"Save 20% when you book 3 trips a week\". Short version for the push: \"3 trips, 20% off\".", { reply: 10, toMe: false }],
    [13, "me", 0, 10, 48, "Looks good. One change: \"Save 20% on your 3rd trip each week\" is clearer about what you get.", { reply: 12 }],
    [14, 208, 0, 10, 50, "Much better, updating now 🙏", { reply: 13, toMe: true }],
    [15, 204, 0, 11, 5, "Lunch order going out in 10 min — 🍜 or 🍕?", { r: [{ emoji: "🍜", count: 6, mine: true }, { emoji: "🍕", count: 3, mine: false }] }],
  ]);
  build(101, [
    [1, 201, 1, 18, 2, "Thanks for the review yesterday, super helpful."],
    [2, "me", 1, 18, 10, "Anytime! The dashboard looks great."],
    [3, 201, 0, 10, 58, "Quick one: can we move our 1:1 to Thursday? Wednesday is packed with the launch."],
    [4, 201, 0, 10, 59, "Same time works for me if it works for you."],
    [5, 201, 0, 11, 1, "We'll improve those parts step by step after the launch.", { fwd: 207 }],
  ]);
  build(-1002, [
    [101, 207, 0, 8, 30, "Morning dispatch: 412 orders, 38 drivers online, average pickup 6 min.", { topic: 10 }],
    [102, 204, 0, 9, 10, "District 7 is short on drivers, moving 5 from District 1.", { topic: 10 }],
    [103, 207, 0, 9, 12, "👍 done, ETA back under 8 min.", { topic: 10, reply: 102 }],
    [104, 206, 0, 10, 2, "Lunch peak starts in an hour, surge pricing is on for District 3.", { topic: 10 }],
  ]);
  for (const id of [-1003, -1004, -1005, 102, 103, 104, 109, -1006, -1007]) if (!MSGS[id]) build(id, [[1, id > 0 ? (id === 109 ? 209 : id + 100) : 205, 0, 9, 0, "…"]]);
  build(103, [[1, 203, 0, 10, 20, "Do you have 10 minutes before the partner sync? Want to align on the API pricing."]]);
  build(109, [[1, 209, 0, 11, 2, "✅ release-4.2 deployed to staging (build #1842)"]]);

  const chatInfo = (c) => ({ ...c });
  const mentionsOf = () => {
    const out = [];
    for (const c of CHATS) for (const m of MSGS[c.id] || []) if (!m.out && (m.mentioned || m.reply_to_me)) {
      const target = m.reply_to && MSGS[c.id].find((x) => x.id === m.reply_to);
      out.push({ ...m, key: `${c.id}:${m.id}`, chat: { id: c.id, name: c.name, kind: c.kind, photo: null, muted: c.muted, link: null },
        kind: m.reply_to_me ? "reply" : "mention", replying_to: target?.out ? target.text : null, unread: m.id === 10, topic: null, read_at: null });
    }
    out.push({ ...MSGS[-1001][1], id: 902, key: "-1003:902", chat: { id: -1003, name: "Design Crit", kind: "group", photo: null }, kind: "mention", flags: ["mention"],
      text: "@alexm what do you think of the new onboarding illustrations? Two options in the Figma file.", sender: P[208], unread: true, reply_to: null, ...at(0, 8, 47) });
    out.push({ ...MSGS[-1001][1], id: 903, key: "-1005:903", chat: { id: -1005, name: "Partner Integrations", kind: "group", photo: null }, kind: "reply", flags: ["reply_to_me"],
      text: "Webhook retries are live. Failed callbacks now retry 5 times with backoff, as you suggested.", replying_to: "Can we retry failed webhooks instead of dropping them?",
      sender: P[207], unread: false, reply_to: null, ...at(1, 15, 20) });
    out.push({ ...MSGS[-1001][1], id: 904, key: "-1004:904", chat: { id: -1004, name: "Engineering", kind: "group", photo: null }, kind: "mention", flags: ["mention"],
      text: "cc @alexm — the on-call rotation for December is up, please check your dates.", sender: P[206], unread: false, reply_to: null, ...at(2, 11, 5) });
    return out.sort((a, b) => b.ts - a.ts);
  };
  function threadOf(chatId, id) {
    const root = rootOf(chatId, id);
    const msgs = MSGS[chatId];
    return { root: msgs.find((m) => m.id === root), replies: msgs.filter((m) => m.reply_to && rootOf(chatId, m.id) === root), complete: true, following: true, unread: 0 };
  }
  const THREADS = () => [[-1001, 10, 1], [-1001, 1, 0], [-1002, 102, 0]].map(([cid, rid, unread]) => {
    const t = threadOf(cid, rid);
    const c = CHATS.find((x) => x.id === cid);
    const last = t.replies[t.replies.length - 1];
    return { key: `${cid}:${rid}`, chat_id: cid, root_id: rid, topic_id: cid === -1002 ? 10 : null, root: t.root, last, last_ts: last.ts,
      replies: t.replies.length, unread, mine: t.replies.some((m) => m.out) ? 1 : 0, chat: chatInfo(c), topic: cid === -1002 ? "Dispatch" : null };
  });
  const HISTORY = [
    { role: "user", text: "What needs me today?" },
    { role: "assistant", text: "Three things need you today, most urgent first:\n\n1. **Approve the pricing copy** — Hana tagged you in **Product Squad** (10:15). It has to go out with release 4.2 **before 2pm**. You already suggested a better line and she's updating it, so a quick 👍 on the final version closes it.\n2. **Linh Tran** wants to move your 1:1 from Wednesday to **Thursday, same time**. Just needs a yes.\n3. **Aisha Khan** asked for 10 minutes before the **3pm partner sync** to align on API pricing.\n\nSafe to skip: *Weekend Football* (143 messages, no mention of you) and *Deploy Bot* (staging deploys, all green)." },
  ];

  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const p = url.pathname, q = url.searchParams;
    if (!p.startsWith("/api/")) return realFetch(input, opts);
    const method = (opts.method || "GET").toUpperCase();
    if (p === "/api/state") return json({ me: ME, status: "ready", sending_enabled: true, mark_read_enabled: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      refreshing: false, live: true, snapshot_at: "", totals: { chats: CHATS.length, unread: 187, must: 3, maybe: 6, noise: 3, noise_unread: 149 },
      mentions_unread: 2, threads_unread: 1, chats: CHATS, topics: TOPICS, history: shot === "manager" ? HISTORY : [] });
    if (p === "/api/prefs") return json(method === "GET" ? { shortcuts: {}, ui: { forumOpen: [-1002], readMode: "keep" } } : { ok: true });
    if (p === "/api/chats") return json({ chats: CHATS });
    if (p === "/api/folders") return json({ folders: [] });
    if (p === "/api/mentions") {
      const f = q.get("filter") || "all";
      const items = mentionsOf().filter((m) => f === "all" || (f === "unread" ? m.unread : m.kind === f));
      return json({ items, has_more: false, unread: 2, fetched_at: now / 1000 });
    }
    if (p === "/api/threads") return json({ items: THREADS().filter((t) => q.get("unread") !== "true" || t.unread), has_more: false, unread: 1 });
    if (p === "/api/unreads") return json({ items: CHATS.filter((c) => c.tier === "must").map((c) => ({ chat: c, tier: c.tier, why: c.why, messages: (MSGS[c.id] || []).slice(-2) })) });
    let m;
    if ((m = p.match(/^\/api\/chat\/(-?\d+)\/thread\/(\d+)$/))) return json(threadOf(Number(m[1]), Number(m[2])));
    if ((m = p.match(/^\/api\/chat\/(-?\d+)\/msg\/(\d+)\/reactions$/))) {
      const msg = (MSGS[Number(m[1])] || []).find((x) => x.id === Number(m[2]));
      const pool = [P[203], P[205], P[206], P[207], P[208], P[201], P[204]];
      const people = [];
      for (const r of msg?.reactions || []) for (let i = 0; i < r.count; i++) people.push(r.mine && i === 0 ? { ...ME, id: 1, me: true, emoji: r.emoji } : { ...pool[(i + people.length) % pool.length], me: false, emoji: r.emoji });
      return json({ people });
    }
    if ((m = p.match(/^\/api\/chat\/(-?\d+)$/))) {
      const id = Number(m[1]), topic = Number(q.get("topic")) || null;
      const c = CHATS.find((x) => x.id === id);
      const msgs = (MSGS[id] || []).filter((x) => !topic || x.topic_id === topic);
      return json({ chat: chatInfo(c), tier: c.tier, why: c.why, topic: topic ? TOPICS[String(id)]?.find((t) => t.id === topic) : null,
        read_upto: c.unread_count ? msgs[Math.max(0, msgs.length - Math.min(c.unread_count, 3)) - 1]?.id || 0 : 1e9, messages: msgs, has_older: false, has_newer: false });
    }
    if ((m = p.match(/^\/api\/chat\/(-?\d+)\/upload$/))) {  // pretend to send: echo a message back
      const id = Number(m[1]);
      const name = decodeURIComponent(opts.headers?.["X-Filename"] || "file");
      window.__demoUploads = [...(window.__demoUploads || []), { chat: id, name, caption: decodeURIComponent(opts.headers?.["X-Caption"] || ""), replyTo: opts.headers?.["X-Reply-To"] }];
      const t = at(0, now.getHours(), now.getMinutes());
      return json({ message: { id: 9000 + window.__demoUploads.length, chat_id: id, topic_id: null, image: null, date: t.date, sender: { ...ME, id: 1 }, text: decodeURIComponent(opts.headers?.["X-Caption"] || ""),
        out: true, mentioned: false, reply_to_me: false, reply_to: Number(opts.headers?.["X-Reply-To"]) || null, thread_top: Number(opts.headers?.["X-Thread-Root"]) || null, reply_count: 0,
        media: /\.(png|jpe?g|gif|webp)$/i.test(name) ? "photo" : `file: ${name}`, forwarded: false, fwd: null, link: null, pinned: false, edited: false, reactions: [], flags: ["from_me"] } });
    }
    if (method !== "GET") return json({ ok: true, unread: 0, count: 0 });
    return json({ items: [], messages: [], chats: [], people: [] });
  };
  // Live updates: a quiet, always-connected stream
  window.EventSource = class {
    constructor() { setTimeout(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: "hello", connected: true }) }); }, 50); }
    close() {}
  };

  // Screenshot scenes
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.addEventListener("load", async () => {
    document.body.classList.add("demo");
    while (typeof state === "undefined" || !state || !allChats.length) await wait(100);
    await wait(400);
    if (shot === "hero") { navigate({ view: "chat", chatId: -1001 }); await wait(300); openThread(10); }
    else if (shot === "mentions") navigate({ view: "mentions" });
    else if (shot === "threads") navigate({ view: "threads" });
    else if (shot === "calm") { navigate({ view: "chat", chatId: -1001 }); await wait(200); uiPrefs.calm = true; applyCalm(); }
    else if (shot === "dm") navigate({ view: "chat", chatId: 101 });
    else if (shot === "topics") navigate({ view: "chat", chatId: -1002, topic: 10 });
    else if (shot === "manager") navigate({ view: "manager" });
    else if (shot === "unreads") navigate({ view: "unreads" });
    await wait(300);
    const feed = document.querySelector("#chat-feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
  });
})();
