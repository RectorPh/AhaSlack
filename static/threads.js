"use strict";
// Slack-style threads on top of Telegram replies. Loaded after app.js, slack.js and live.js.
//
// Which thread a message belongs to: the rules live in thread-rules.js (certain ones from Telegram's
// Reply links, guessed ones marked AUTO). The channel then shows only thread roots, with a
// "N replies" bar under each, and the thread opens in the right pane with its own message box.

const threadsOn = () => uiPrefs.threads !== false;
const GUESSED = new Set(["burst", "answer", "ai"]);
let threadView = null;  // the thread open in the pane: {chatId, rootId, root, replies, target, loading}

// ---------------------------------------------------------------- grouping (the rules)
function buildThreads(msgs) {
  return buildThreadsWith(msgs, { overrides: threadOverride, guesses: uiPrefs.threadGuess !== false });
}
const sameSender = (a, b) => (a.out && b.out) || (!a.out && !b.out && a.sender?.peer === b.sender?.peer);
// Corrections you make ("Not part of this thread") win over the rules; kept for training a model later.
function threadOverride(m) { return (uiPrefs.threadFix || {})[`${m.chat_id}:${m.id}`]; }

// ---------------------------------------------------------------- the channel: thread bars and stubs
function people(msgs) {
  const seen = new Map();
  for (const m of msgs) {
    const p = m.out ? { peer: state.me.peer, photo: state.me.photo, name: state.me.name } : m.sender;
    if (p && !seen.has(p.peer)) seen.set(p.peer, p);
  }
  return [...seen.values()];
}
function threadBar(t) {
  const n = Math.max(t.replies.length, t.root?.reply_count || 0);
  if (!n) return "";
  const last = t.replies[t.replies.length - 1];
  const fresh = t.replies.filter((m) => !m.out && m.id > chatMeta.readUpto).length;
  const faces = people(t.replies).slice(0, 4).map((p) => av(p, "s20")).join("");
  return `<button class="thread-bar ${fresh ? "has-new" : ""}" data-thread="${t.rootId}">${faces}
    <b>${n} ${n === 1 ? "reply" : "replies"}</b>${fresh ? `<span class="tb-new">${fresh} new</span>` : ""}
    <span class="tb-last">${last ? `Last reply ${esc(dayLabel(last.date).toLowerCase())} at ${esc(last.date.slice(11))}` : "View thread"}</span>
    <span class="tb-view">View thread ›</span></button>`;
}
// A thread whose first message is further up than what's loaded: shown where its latest reply is.
function threadStub(t, m) {
  const p = m.out ? { peer: state.me.peer, photo: state.me.photo, name: state.me.name } : m.sender;
  const text = (m.text || m.media || "").slice(0, 160);
  return `<div class="msg thread-stub" data-id="${m.id}">${av(p)}<div class="msg-body">
    <div class="msg-head"><span class="who">${esc(p.name)}${m.out ? " (you)" : ""}</span><span class="stub-note">replied to a thread</span><span class="when">${esc(m.date.slice(11))}</span></div>
    <div class="tg-text stub-text">${tgText(text)}</div>${threadBar(t)}</div></div>`;
}

// ---------------------------------------------------------------- the thread pane
function showPaneMode(mode) {  // "manager" | "thread": the right pane holds one or the other, like Slack
  $("#pane").dataset.mode = mode;
  $("#pane-mount").hidden = mode !== "manager";
  $("#thread-mount").hidden = mode !== "thread";
  $(".pane-title", $("#pane")).textContent = mode === "thread" ? "Thread" : "Inbox Manager";
}
async function openThread(msgId, { focus = null, reply = false } = {}) {
  if (view !== "chat") return;
  const chatId = currentChat;
  const T = buildThreads(chatMessages);
  const rootId = T.rootOf.get(msgId) ?? msgId;
  const local = T.threads.get(rootId);
  threadView = { chatId, rootId, root: local?.root || chatMessages.find((m) => m.id === rootId) || null,
    replies: local?.replies ? [...local.replies] : [], target: null, focus: focus ?? (msgId !== rootId ? msgId : null), loading: true };
  $("#pane").hidden = false;
  showPaneMode("thread");
  mountManager();
  const c = chatById(chatId);
  const t = currentTopic ? topicById(chatId, currentTopic) : null;
  $("#pane-sub").textContent = t ? `#${t.title} · ${c?.name || ""}` : `${c?.kind === "dm" ? "" : "#"}${c?.name || ""}`;
  renderThread();
  if (reply) $("#thread-input")?.focus();
  let data;
  try {
    data = await api(`/api/chat/${chatId}/thread/${rootId}${currentTopic ? `?topic=${currentTopic}` : ""}`);
  } catch (e) {
    if (threadView?.rootId === rootId) { threadView.loading = false; threadView.error = e.message; renderThread(); }
    return;
  }
  if (!threadView || threadView.chatId !== chatId || threadView.rootId !== rootId) return;
  const ids = new Set(data.replies.map((m) => m.id));
  const extra = threadView.replies.filter((m) => !ids.has(m.id) && m.id !== data.root.id);  // rule 2 follow-ups
  Object.assign(threadView, { rootId: data.root.id, root: data.root, loading: false,
    replies: [...data.replies, ...extra].sort((a, b) => a.id - b.id), via: T.via });
  renderThread();
  if (data.following && data.unread) markThreadRead(chatId, data.root.id);
}
function closeThread() { threadView = null; }

function renderThread() {
  const tv = threadView;
  const mount = $("#thread-mount");
  if (!tv) return;
  const scrollBox = $(".thread-scroll", mount);
  const atBottom = !scrollBox || scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 60;
  const actions = (m) => (state.sending_enabled ? `<button data-th-react="${m.id}" title="Add reaction">☺</button><button data-th-reply="${m.id}" title="Reply to this message in the thread">↩</button>` : "") +
    (m.link ? `<a class="ext" href="${esc(m.link)}" target="_blank" rel="noopener">↗</a>` : "") +
    (GUESSED.has(tv.via?.get(m.id)) || tv.via?.get(m.id) === "manual" ? `<button data-th-unthread="${m.id}" title="Not part of this thread: show it in the channel">⇱</button>` : "");
  let prev = null;
  const rows = tv.replies.map((m) => {
    const auto = GUESSED.has(tv.via?.get(m.id)) ? `<span class="tag auto" title="${esc(THREAD_RULE_LABEL[tv.via.get(m.id)])} · ⇱ moves it back">${tv.via.get(m.id) === "ai" ? "AI" : "AUTO"}</span>` : "";
    const row = msgRow(m, prev, { actions: actions(m), tag: auto, cls: m.id === tv.focus ? "focus" : "" });
    prev = m;
    return row;
  }).join("");
  const n = tv.replies.length;
  const name = (m) => m.out ? "yourself" : m.sender?.name || "message";
  const target = tv.target || tv.root;
  mount.innerHTML = `<div class="thread-scroll">
      ${tv.root ? msgRow(tv.root, null, { actions: actions(tv.root), cls: "thread-root" }) : `<div class="loading">Finding the start of this thread…</div>`}
      <div class="thread-count"><span>${tv.loading ? "Loading replies…" : `${n} ${n === 1 ? "reply" : "replies"}`}</span></div>
      ${rows}
      ${tv.error ? `<div class="empty err">${esc(tv.error)}</div>` : ""}
    </div>
    ${state.sending_enabled ? `<form class="composer" id="thread-composer">
      ${tv.target ? `<div class="reply-chip"><span class="rc-text">↩ Reply to <b>${esc(name(tv.target))}</b>: ${esc((tv.target.text || tv.target.media || "").slice(0, 80))}</span><button type="button" class="icon-btn" data-th-retarget title="Reply to the thread instead">✕</button></div>` : ""}
      <textarea rows="1" id="thread-input" placeholder="Reply in thread…"></textarea>
      <div class="composer-bar"><span class="hint">Sends as a Telegram reply · lands in this thread</span><button type="submit" class="send" title="Send (Enter)">➤</button></div>
    </form>` : `<div class="pane-note">Replying needs sending_enabled = true in config.toml.</div>`}`;
  const box = $(".thread-scroll", mount);
  const f = tv.focus && $(`.msg[data-id="${tv.focus}"]`, box);
  if (f && !tv.scrolledToFocus) { f.scrollIntoView({ block: "center" }); tv.scrolledToFocus = true; }
  else if (atBottom) box.scrollTop = box.scrollHeight;
  const form = $("#thread-composer", mount);
  if (form) {
    const input = $("#thread-input", form);
    if (tv.draft) setInput(form, input, tv.draft);
    input.addEventListener("input", () => { tv.draft = input.value; });
    wireComposer(form, input, (v) => sendInThread(v));
  }
}

async function sendInThread(text) {
  const tv = threadView;
  if (!tv || !tv.root || !needWrites()) return;
  const form = $("#thread-composer");
  const target = (tv.target || tv.root).id;
  tv.draft = "";
  try {
    const { message } = await postJson(`/api/chat/${tv.chatId}/send`, { text: expandMentions(tv.chatId, text), reply_to: target, thread_root: tv.rootId,
      topic: tv.chatId === currentChat ? currentTopic : null });
    lastSent = { chatId: tv.chatId, msgId: message.id, at: Date.now() };
    addToThread(message);
    tv.target = null;
    renderThread();
    $("#thread-input")?.focus();
  } catch (e) {
    tv.draft = text;
    renderThread();
    toast(`Not sent: ${esc(e.message)}`, true, 7000);
  }
  void form;
}
// A new message (sent here, or arriving live): into the channel's list and, if it's in the open thread, the pane.
function addToThread(m) {
  if (view === "chat" && currentChat === m.chat_id && !chatMessages.some((x) => x.id === m.id)) {
    chatMessages.push(m);
    rerenderChat();
  }
  const tv = threadView;
  if (!tv || tv.chatId !== m.chat_id || tv.replies.some((x) => x.id === m.id)) return false;
  const T = buildThreads(view === "chat" && currentChat === tv.chatId ? chatMessages : [tv.root, ...tv.replies, m].filter(Boolean));
  const inThread = (T.rootOf.get(m.id) ?? null) === tv.rootId || m.thread_top === tv.rootId || m.reply_to === tv.rootId ||
    tv.replies.some((x) => x.id === m.reply_to);
  if (!inThread) return false;
  tv.replies.push(m);
  if (GUESSED.has(T.via.get(m.id))) (tv.via ||= new Map()).set(m.id, T.via.get(m.id));
  renderThread();
  return true;
}

$("#thread-mount").addEventListener("click", (e) => {
  const tv = threadView;
  if (!tv) return;
  const all = [tv.root, ...tv.replies].filter(Boolean);
  const find = (id) => all.find((m) => m.id === Number(id));
  const r = e.target.closest("[data-th-reply]");
  if (r) { tv.target = find(r.dataset.thReply); tv.target = tv.target?.id === tv.rootId ? null : tv.target; renderThread(); return $("#thread-input")?.focus(); }
  if (e.target.closest("[data-th-retarget]")) { tv.target = null; renderThread(); return; }
  const rx = e.target.closest("[data-th-react]");
  if (rx) { const m = find(rx.dataset.thReact); if (m) reactPicker(m, rx); return; }
  const un = e.target.closest("[data-th-unthread]");
  if (un) {
    const m = find(un.dataset.thUnthread);
    uiPrefs.threadFix = { ...(uiPrefs.threadFix || {}), [`${m.chat_id}:${m.id}`]: 0 };
    saveUi();
    tv.replies = tv.replies.filter((x) => x.id !== m.id);
    renderThread();
    rerenderChat();
    toast("Moved back to the channel. AhaSlack remembers this correction.");
  }
});

async function setThreadRead(chatId, rootId, read) {
  let res;
  try { res = await postJson("/api/threads/read", { chat_id: chatId, root_id: rootId, read }); }
  catch (e) { return toast(`Couldn't update: ${esc(e.message)}`, true); }
  const t = threadsData?.items.find((x) => x.chat_id === chatId && x.root_id === rootId);
  if (t) t.unread = read ? 0 : Math.max(1, t.unread);
  threadsData.unread = res.unread;
  setThreadsBadge(res.unread);
  if (threadsFilter === "unread" && read && t) threadsData.items = threadsData.items.filter((x) => x !== t);
  renderThreadsView();
}
async function markAllThreadsRead() {
  let res;
  try { res = await postJson("/api/threads/read-all", {}); } catch (e) { return toast(`Couldn't update: ${esc(e.message)}`, true); }
  for (const t of threadsData?.items || []) t.unread = 0;
  threadsData.unread = 0;
  if (threadsFilter === "unread") threadsData.items = [];
  setThreadsBadge(0);
  renderThreadsView();
  toast(`✓ Marked ${res.count} thread${res.count === 1 ? "" : "s"} as read`);
}

async function markThreadRead(chatId, rootId) {
  try {
    const res = await postJson("/api/threads/read", { chat_id: chatId, root_id: rootId });
    setThreadsBadge(res.unread);
    const item = threadsData?.items.find((t) => t.chat_id === chatId && t.root_id === rootId);
    if (item) item.unread = 0;
  } catch { /* the count catches up on the next refresh */ }
}

// ---------------------------------------------------------------- the Threads view (threads you're in)
let threadsData = null;
let threadsFilter = "all";  // "all" | "unread"
function setThreadsBadge(n) {
  if (state) state.threads_unread = n;
  const b = $("#threads-badge");
  if (b) { b.textContent = n || ""; b.hidden = !n; }
}
async function loadThreads(more = false) {
  const feed = $("#threads-feed");
  if (!more) feed.innerHTML = `<div class="loading">Loading your threads…</div>`;
  const last = more && threadsData?.items[threadsData.items.length - 1];
  let data;
  try { data = await api(`/api/threads?limit=30${threadsFilter === "unread" ? "&unread=true" : ""}${last ? `&before=${last.last_ts}` : ""}`); }
  catch (e) { feed.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
  threadsData = more ? { ...data, items: [...threadsData.items, ...data.items] } : data;
  setThreadsBadge(data.unread);
  renderThreadsView();
}
function renderThreadsView() {
  const feed = $("#threads-feed");
  const items = threadsData.items;
  const unread = threadsData.unread || 0;
  const bar = `<div class="tabs th-tabs"><button data-th-filter="all" class="${threadsFilter === "all" ? "on" : ""}">All</button>
      <button data-th-filter="unread" class="${threadsFilter === "unread" ? "on" : ""}">Unread${unread ? ` <span class="cnt">${unread}</span>` : ""}</button></div>
    ${unread ? `<div class="act-summary">${unread} thread${unread === 1 ? "" : "s"} with new replies · <a href="#" data-th-read-all>Mark all as read</a></div>` : ""}`;
  if (!items.length) {
    feed.innerHTML = bar + (threadsFilter === "unread"
      ? `<div class="empty"><div class="big">🎉</div>No new replies in your threads.</div>`
      : `<div class="empty"><div class="big">🧵</div>No threads yet.<br><span class="sub">Threads you reply in, and replies to you, show up here.</span></div>`);
    return;
  }
  feed.innerHTML = bar + items.map((t) => {
    const c = t.chat;
    const where = t.topic ? `# ${esc(t.topic)} · ${esc(c.name)}` : esc(chatLabel(c));
    const root = t.root ? msgRow(t.root, null, {}) : `<div class="sub thread-noroot">The first message isn't available.</div>`;
    const last = t.last && t.last.id !== t.root_id ? msgRow(t.last, null, { cls: "thread-last" }) : "";
    return `<div class="thread-card ${t.unread ? "unread" : ""}" data-chat="${t.chat_id}" data-root="${t.root_id}" data-topic="${t.topic_id || ""}">
      <div class="tc-head">${t.unread ? `<span class="dot"></span>` : ""}<b>${where}</b><span class="sp"></span>${t.unread ? `<span class="tb-new">${t.unread} new</span>` : ""}<span class="sub">${t.last ? esc(dayLabel(t.last.date)) : ""}</span></div>
      ${root}
      <div class="tc-mid">${t.mine ? "You replied" : "Replied to you"} · latest reply:</div>
      ${last}
      <div class="tc-foot"><button class="btn" data-open-thread>View thread ›</button>
        <button class="btn" data-th-toggle title="${t.unread ? "Mark this thread as read" : "Mark this thread as unread"}">${t.unread ? "✓ Mark as read" : "Mark unread"}</button></div></div>`;
  }).join("") + (threadsData.has_more ? `<button class="load-older" data-more-threads>Load older threads</button>` : "");
}
$("#threads-feed").addEventListener("click", (e) => {
  if (e.target.closest("[data-more-threads]")) return loadThreads(true);
  const f = e.target.closest("[data-th-filter]");
  if (f) { threadsFilter = f.dataset.thFilter; return loadThreads(); }
  if (e.target.closest("[data-th-read-all]")) { e.preventDefault(); return markAllThreadsRead(); }
  if (e.target.closest("a, .att, .react-chip")) return;
  const card = e.target.closest(".thread-card");
  if (!card) return;
  const chatId = Number(card.dataset.chat), root = Number(card.dataset.root);
  if (e.target.closest("[data-th-toggle]")) {
    const t = threadsData.items.find((x) => x.chat_id === chatId && x.root_id === root);
    return setThreadRead(chatId, root, !!t?.unread);
  }
  const c = chatById(chatId);
  navigate({ view: "chat", chatId, focus: root, topic: c?.forum && card.dataset.topic ? Number(card.dataset.topic) : undefined, thread: root });
});

// ---------------------------------------------------------------- wiring into the channel view
$("#chat-feed").addEventListener("click", (e) => {
  const b = e.target.closest("[data-thread]");
  if (b) { e.stopPropagation(); openThread(Number(b.dataset.thread)); }
}, true);
// Slack: a reply opens the thread (with its message box) instead of quoting in the channel.
const _setReply = setReply;
setReply = function (m) {
  if (!threadsOn() || view !== "chat") return _setReply(m);
  openThread(m.id, { reply: true });
  if (threadView) threadView.target = m.id === threadView.rootId ? null : m;
};
// The pane's ✕ and switching chats close the thread.
$("#pane-close").addEventListener("click", closeThread);
const _openPane = openPane;
openPane = function (sub) { closeThread(); showPaneMode("manager"); _openPane(sub); };
const _closePane = closePane;
closePane = function () { closeThread(); _closePane(); };
const _setView = setView;
setView = function (name) {
  if (name !== "chat" && threadView) { closeThread(); $("#pane").hidden = true; }
  _setView(name);
};
const _openChat = openChat;
openChat = async function (id, opts = {}) {
  if (threadView && (threadView.chatId !== id)) { closeThread(); if ($("#pane").dataset.mode === "thread") $("#pane").hidden = true; }
  await _openChat(id, opts);
  if (opts.thread && view === "chat" && currentChat === id) openThread(opts.thread);
};
// A message you jumped to (mention, search, link) that sits inside a thread: open that thread.
function focusInThread(msgId) {
  if (!threadsOn()) return null;
  const T = buildThreads(chatMessages);
  const root = T.rootOf.get(msgId);
  if (root == null) return null;
  openThread(msgId, { focus: msgId });
  const m = chatMessages.find((x) => x.id === msgId);
  return $(`#chat-feed .msg[data-id="${root}"]`) || (m && $(`#chat-feed .thread-stub[data-id="${(T.threads.get(root)?.replies.at(-1) || m).id}"]`));
}

ACTIONS.push({ group: "This app (not in Slack)", id: "threads-toggle", label: "Group replies into threads (Slack style)", def: "Mod+Alt+Shift+T", alt: [], when: "any",
  run: () => { uiPrefs.threads = !threadsOn(); saveUi(); if (view === "chat") rerenderChat(); toast(threadsOn() ? "🧵 Replies are grouped into threads" : "Replies show in the channel, like Telegram"); } });
