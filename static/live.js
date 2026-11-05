"use strict";
// Real-time sync (Server-Sent Events from /api/events), desktop notifications, Slack's
// "when I view a conversation" read behavior, the unread banner, and Calm Space.
// Loaded after app.js and slack.js and uses their globals.

let liveOk = false;
let liveSource = null;
let pendingNew = 0;  // live messages that arrived while you were scrolled up

// ---------------------------------------------------------------- the event stream
function connectLive() {
  liveSource?.close();
  liveSource = new EventSource("/api/events");
  liveSource.onopen = () => { liveOk = true; showLiveStatus(); };
  liveSource.onerror = () => { liveOk = false; showLiveStatus(); };  // EventSource reconnects by itself
  liveSource.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "hello" || ev.type === "ping") { liveOk = ev.connected !== false; showLiveStatus(); return; }
    ({ message: onLiveMessage, edit: onLiveEdit, delete: onLiveDelete, read: onLiveRead, topic_read: onTopicRead })[ev.type]?.(ev);
  };
}
function showLiveStatus() {
  const el = $("#status");
  if (!el || state?.refreshing) return;
  el.innerHTML = liveOk ? `<span class="live-dot">●</span> Live` : `<span class="err">● Reconnecting…</span>`;
}

let sidebarQueued = false;
function sidebarSoon() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  requestAnimationFrame(() => { sidebarQueued = false; renderSidebar(); });
}
function upsertChat(info) {
  const fields = { id: info.id, name: info.name, username: info.username, kind: info.kind, muted: info.muted,
    unread_count: info.unread_count, unread_mentions: info.unread_mentions, photo: info.photo, last_ts: info.last_ts, link: info.link };
  for (const list of [state?.chats, allChats]) {
    if (!list) continue;
    const c = list.find((x) => x.id === info.id);
    if (c) Object.assign(c, fields, info.tier ? { tier: info.tier, why: info.why } : {});
    else list.unshift({ ...fields, tier: info.tier || null, why: info.why || "", ignored: !!info.ignored });
  }
}
const nearBottom = (feed) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;

function onLiveMessage(ev) {
  const m = ev.message;
  const chat = ev.chat;
  upsertChat(chat);
  if (ev.topic && state?.topics?.[String(chat.id)]) {  // count it on its topic
    const ts = state.topics[String(chat.id)];
    const t = ts.find((x) => x.id === ev.topic.id);
    if (t) Object.assign(t, ev.topic); else ts.unshift({ ...ev.topic, closed: false, pinned: false, hidden: false });
  }
  sidebarSoon();
  const inView = !currentTopic || m.topic_id === currentTopic;  // a topic view only shows its own messages
  // The open conversation: show it now, like Slack
  if (view === "chat" && currentChat === chat.id && inView && !chatMeta.hasNewer && !chatMessages.some((x) => x.id === m.id)) {
    const feed = $("#chat-feed");
    const stick = nearBottom(feed);
    const prev = chatMessages[chatMessages.length - 1];
    chatMessages.push(m);
    $(".empty", feed)?.remove();
    if (threadsOn() && (buildThreads(chatMessages).rootOf.has(m.id) || m.reply_count)) rerenderChat();  // a thread reply: the bar updates
    else feed.insertAdjacentHTML("beforeend", chatRow(m, prev, m.out ? "" : "just-arrived"));
    if (stick) feed.scrollTop = feed.scrollHeight;
    else if (!m.out) { pendingNew++; showNewPill(); }
    if (!m.out && stick && document.hasFocus() && readsOnView()) scheduleAutoRead(chat.id);
  }
  // Threads: the open thread, and the Threads view
  const inOpen = threadView && threadView.chatId === chat.id && addToThread(m);
  if (ev.thread) {
    if (inOpen && document.hasFocus()) markThreadRead(chat.id, ev.thread.root_id);
    else {
      setThreadsBadge(ev.thread.unread);
      if (!m.out && !ev.notify && uiPrefs.notify !== false) playNotifySound("thread");  // a new reply in a thread you're in
    }
    if (view === "threads") loadThreads();
  }
  // Activity
  if (ev.mention && mentionData) {
    mentionData.items.unshift({ ...m, key: `${chat.id}:${m.id}`, chat: { id: chat.id, name: chat.name, kind: chat.kind, photo: chat.photo, muted: chat.muted, link: chat.link },
      kind: (m.flags || []).includes("reply_to_me") ? "reply" : "mention", replying_to: null, unread: true, ts: Date.now() / 1000, topic: ev.topic?.title });
    mentionData.unread = (mentionData.unread || 0) + 1;
    if (view === "mentions") renderMentions();
  }
  if (ev.mention) { state.mentions_unread = (state.mentions_unread || 0) + 1; updateMentionBadge(mentionData ? mentionData.unread : state.mentions_unread); }
  if (view === "unreads") unreadsSoon();
  if (ev.notify) notify(chat, m);
}
function onLiveEdit(ev) {
  if (view !== "chat" || currentChat !== ev.chat_id) return;
  const m = chatMessages.find((x) => x.id === ev.message.id);
  if (!m) return;
  Object.assign(m, ev.message, { edited: true });
  rerenderChat();
}
function onLiveDelete(ev) {
  if (view !== "chat" || (ev.chat_id != null && ev.chat_id !== currentChat)) return;
  const ids = new Set(ev.ids);
  const before = chatMessages.length;
  chatMessages = chatMessages.filter((m) => !ids.has(m.id));
  if (chatMessages.length !== before) rerenderChat();
}
function syncMentionReads(ev) {  // mentions read elsewhere (phone, Telegram Desktop, Esc)
  if (ev.mentions_unread == null) return;
  const keys = new Set(ev.mentions_read || []);
  if (mentionData) {
    for (const m of mentionData.items) if (keys.has(m.key)) m.unread = false;
    if (view === "mentions" && keys.size) renderMentions();
  }
  state.mentions_unread = ev.mentions_unread;
  updateMentionBadge(ev.mentions_unread);
}
function onLiveRead(ev) {  // you read it on your phone or Telegram Desktop
  syncMentionReads(ev);
  for (const list of [state?.chats, allChats]) {
    const c = list?.find((x) => x.id === ev.chat_id);
    if (c) { c.unread_count = ev.unread; if (!ev.unread) c.unread_mentions = 0; }
  }
  if (mentionData) for (const m of mentionData.items) if (m.chat.id === ev.chat_id && m.id <= ev.max_id) m.unread = false;
  sidebarSoon();
  if (view === "mentions") renderMentions();
}
function onTopicRead(ev) {
  syncMentionReads(ev);
  const t = state?.topics?.[String(ev.chat_id)]?.find((x) => x.id === ev.topic_id);
  if (t) { t.unread_count = ev.unread; if (!ev.unread) t.unread_mentions = 0; }
  sidebarSoon();
}
let unreadsTimer = null;
function unreadsSoon() { clearTimeout(unreadsTimer); unreadsTimer = setTimeout(() => view === "unreads" && loadUnreads(), 1500); }

// ---------------------------------------------------------------- desktop notifications (DMs and mentions)
document.addEventListener("click", () => {  // browsers only ask after a user gesture
  if ("Notification" in window && Notification.permission === "default" && uiPrefs.notify !== false) Notification.requestPermission();
}, { once: true });
function notify(chat, m) {
  if (uiPrefs.notify === false) return;
  const looking = document.hasFocus() && !document.hidden && view === "chat" && currentChat === chat.id;
  if (looking) return;
  playNotifySound(chat.kind === "dm" ? "dm" : "mention");  // sounds.js
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const who = m.sender?.name || chat.name;
  const n = new Notification(chat.kind === "dm" ? who : `${who} in ${chat.name}`, {
    body: (m.text || (m.media ? `[${m.media}]` : "")).slice(0, 180),
    tag: `${chat.id}`, silent: soundsOn(chat.kind === "dm" ? "dm" : "mention"),  // our own sound instead of the system's
  });
  n.onclick = () => { window.focus(); navigate({ view: "chat", chatId: chat.id, focus: m.id, topic: m.topic_id || undefined }); n.close(); };
}

// ---------------------------------------------------------------- reading, like Slack
// Slack Preferences > Mark as read: "When I view a channel:"
const READ_MODES = {
  leftoff: "Start me where I left off, and mark the channel read",
  newest: "Start me at the newest message, and mark the channel read",
  keep: "Start me at the newest message, but leave unseen messages unread",
};
const readsOnView = () => state?.mark_read_enabled && (uiPrefs.readMode || "leftoff") !== "keep";
let autoReadTimer = null;
function scheduleAutoRead(chatId) {
  clearTimeout(autoReadTimer);
  autoReadTimer = setTimeout(() => {
    if (view === "chat" && currentChat === chatId && document.hasFocus()) markRead(chatId, true, { auto: true });
  }, 1200);
}
// Called by openChat once the messages are on screen.
function applyReadMode(chatId) {
  const feed = $("#chat-feed");
  const line = $(".new-line", feed);
  const mode = uiPrefs.readMode || "leftoff";
  if (mode === "leftoff" && line) line.scrollIntoView({ block: "center" });
  else feed.scrollTop = feed.scrollHeight;
  pendingNew = 0;
  showNewPill();
  showUnreadBanner(chatId);
  if (chatMeta.unread && readsOnView() && document.hasFocus()) scheduleAutoRead(chatId);
}
function showUnreadBanner(chatId) {
  $("#unread-banner")?.remove();
  const c = chatById(chatId);
  const n = chatMeta.unread || c?.unread_count || 0;
  if (!n) return;
  const firstUnread = chatMessages.find((m) => !m.out && m.id > chatMeta.readUpto);
  const since = firstUnread ? ` since ${firstUnread.date.slice(11)}${dayLabel(firstUnread.date) === "Today" ? "" : ` ${dayLabel(firstUnread.date).toLowerCase()}`}` : "";
  $("#chat-feed").insertAdjacentHTML("beforebegin", `<div class="unread-banner" id="unread-banner">
    <span><b>${n > 999 ? "999+" : n} new message${n === 1 ? "" : "s"}</b>${esc(since)}</span><span class="sp"></span>
    <button data-ub="jump">Jump ↑</button>${state.mark_read_enabled && !readsOnView() ? `<button data-ub="read">Mark as read</button>` : ""}<button data-ub="close" title="Dismiss">✕</button></div>`);
}
$("#view-chat").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ub]");
  if (!b) return;
  if (b.dataset.ub === "jump") jumpToUnread();
  if (b.dataset.ub === "read") markRead(currentChat);
  if (b.dataset.ub === "close") $("#unread-banner")?.remove();
});
// "↓ N new messages" when something arrives while you're scrolled up
function showNewPill() {
  let pill = $("#new-pill");
  if (!pendingNew) { pill?.remove(); return; }
  if (!pill) {
    $("#chat-composer").insertAdjacentHTML("beforebegin", `<button class="new-pill" id="new-pill"></button>`);
    pill = $("#new-pill");
    pill.addEventListener("click", () => { const f = $("#chat-feed"); f.scrollTop = f.scrollHeight; });
  }
  pill.textContent = `↓ ${pendingNew} new message${pendingNew === 1 ? "" : "s"}`;
}
$("#chat-feed").addEventListener("scroll", () => {
  const feed = $("#chat-feed");
  if (pendingNew && nearBottom(feed)) {
    pendingNew = 0;
    showNewPill();
    if (readsOnView()) scheduleAutoRead(currentChat);
  }
});
window.addEventListener("focus", () => {  // coming back to the window marks what you're looking at as read
  if (view === "chat" && readsOnView() && chatById(currentChat)?.unread_count && nearBottom($("#chat-feed"))) scheduleAutoRead(currentChat);
});

// ---------------------------------------------------------------- Calm Space
function applyCalm() {
  document.body.classList.toggle("calm", !!uiPrefs.calm);
  $("#calm-toggle").textContent = uiPrefs.calm ? "☀ Leave Calm Space" : "☾ Calm Space";
}
function toggleCalm() {
  uiPrefs.calm = !uiPrefs.calm;
  applyCalm();
  saveUi();
  toast(uiPrefs.calm ? "☾ Calm Space: just the conversation. Press ⌘J again to leave." : "Back to the full view", false, 2500);
}
document.body.insertAdjacentHTML("beforeend", `<button class="calm-toggle" id="calm-toggle" title="Hide everything but the conversation (⌘J)">☾ Calm Space</button>`);
$("#calm-toggle").addEventListener("click", toggleCalm);
ACTIONS.push({ group: "This app (not in Slack)", id: "calm", label: "Calm Space: hide everything but the conversation", def: "Mod+J", alt: ["Mod+Alt+C"], when: "any", run: () => toggleCalm() });

// ---------------------------------------------------------------- Preferences (⌘,): reading, notifications, sidebar, Calm Space
const _openShortcuts = openShortcuts;
openShortcuts = function (tab = "prefs") {
  _openShortcuts(tab);
  let panel = $("#prefs-panel");
  if (!panel) {
    $("#prefs-body").insertAdjacentHTML("afterbegin", `<div class="prefs-panel" id="prefs-panel"></div>`);
    panel = $("#prefs-panel");
    panel.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "readMode") uiPrefs.readMode = t.value;
      if (t.name === "notify") { uiPrefs.notify = t.checked; if (t.checked && "Notification" in window) Notification.requestPermission(); }
      if (t.name === "calm") { uiPrefs.calm = t.checked; applyCalm(); }
      if (t.name === "threads") { uiPrefs.threads = t.checked; if (view === "chat") rerenderChat(); }
      if (t.name === "threadGuess") { uiPrefs.threadGuess = t.checked; if (view === "chat") rerenderChat(); }
      if (t.name === "sort") uiPrefs.sort = t.value;
      if (t.name === "dmNeedsYou") uiPrefs.dmNeedsYou = t.value;
      if (t.name === "show") uiPrefs.show = t.value;
      saveUi();
      renderSidebar();
    });
  }
  const mode = uiPrefs.readMode || "leftoff";
  panel.hidden = tab !== "prefs";
  panel.innerHTML = `<div class="sc-group">Notifications</div>
    <label class="pref"><input type="checkbox" name="notify" ${uiPrefs.notify === false ? "" : "checked"}> Notify me about direct messages and mentions</label>
    <div class="sc-group">Mark as read</div><div class="pref-sub">When I view a conversation:</div>
    ${Object.entries(READ_MODES).map(([k, l]) => `<label class="pref"><input type="radio" name="readMode" value="${k}" ${mode === k ? "checked" : ""}> ${esc(l)}</label>`).join("")}
    ${state?.mark_read_enabled ? "" : `<div class="pref-sub err">Marking read on Telegram is off (mark_read_enabled in config.toml), so nothing is marked read yet.</div>`}
    <div class="sc-group">Threads</div>
    <label class="pref"><input type="checkbox" name="threads" ${uiPrefs.threads === false ? "" : "checked"}> Group replies into threads, like Slack (replies open on the right instead of in the channel)</label>
    <label class="pref"><input type="checkbox" name="threadGuess" ${uiPrefs.threadGuess === false ? "" : "checked"}> Also guess: group follow-ups and short answers sent without Reply (marked AUTO; ⇱ undoes one)</label>
    <div class="pref-sub"><a href="#" onclick="closeShortcuts(); openThreadCheck(); return false;">🎯 Check how accurate the grouping is</a></div>
    <div class="sc-group">Sidebar</div>
    <label class="pref">Sort <select name="sort">${Object.entries(SORTS).map(([k, l]) => `<option value="${k}" ${(uiPrefs.sort || "priority") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      Show <select name="show">${Object.entries(SHOWS).map(([k, l]) => `<option value="${k}" ${(uiPrefs.show || "all") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <label class="pref">Direct messages in Needs you <select name="dmNeedsYou">${Object.entries(DM_NEEDS_YOU).map(([k, l]) => `<option value="${k}" ${(uiPrefs.dmNeedsYou || "important") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <label class="pref"><input type="checkbox" name="calm" ${uiPrefs.calm ? "checked" : ""}> Calm Space: hide the sidebar and everything but the conversation (⌘J)</label>
    <div class="pref-sub" style="margin-top:14px">Keyboard shortcuts are in the other tab.</div>`;
};

connectLive();
