"use strict";
// Telegram Inbox: a Slack-style client for your Telegram.
// Everything from Telegram is escaped before it reaches innerHTML; the manager's markdown goes
// through marked + DOMPurify. Only the user sends messages; the Inbox Manager agent is read-only.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;  // replaced by config.toml's timezone
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_MS = 0;  // 0 = send immediately (no undo window)

let state = null;        // /api/state
let allChats = [];       // /api/chats: every dialog (quick switcher, group search)
let view = "manager";
let currentChat = null;
let busy = false;        // manager is answering
let historyRendered = false;
const collapsed = { quiet: true };
let uiPrefs = {};  // sidebar sort/show, starred chats, read behavior, Calm Space (server-side)
async function saveUi() {
  try { await postJson("/api/prefs", { ui: uiPrefs }); } catch (e) { toast(`Couldn't save preferences: ${esc(e.message)}`, true); }
}
const shown = { must: 12, channels: 12, dms: 12, quiet: 12 };

// ================================================================== helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const linkify = (h) => h.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

function tgText(text, media, highlight) {
  let h = linkify(esc(text || ""));
  const u = state?.me?.username;
  if (u) h = h.replace(new RegExp("@" + reEsc(u), "gi"), (m) => `<span class="at-me">${m}</span>`);
  if (highlight) h = h.replace(new RegExp(`(${reEsc(esc(highlight))})(?![^<]*>)`, "gi"), "<mark>$1</mark>");
  const med = media ? `<span class="media">[${esc(media)}]</span>${text ? " " : ""}` : "";
  return med + h;
}

function md(text) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text || "", { breaks: true })).replace(/<a /g, '<a target="_blank" rel="noopener" ');
  }
  return linkify(esc(text)).replace(/\n/g, "<br>");
}

const PALETTE = ["#c2413b", "#b8620b", "#8a7a00", "#2f8a3e", "#1f7a74", "#2563a8", "#5b4bb7", "#9b3f8f", "#6b6f73"];
function initials(name) {
  const words = String(name || "?").replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}
function color(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initialsHtml = (name, seed, cls) => `<div class="av ${cls}" style="background:${color(seed ?? name)}">${esc(initials(name))}</div>`;
// person: {peer, photo, name}. Real Telegram photo when there is one, initials otherwise.
function av(person, cls = "") {
  const name = person?.name || "?";
  const seed = person?.peer ?? name;
  if (person?.peer != null && person.photo) {
    return `<img class="av ${cls}" loading="lazy" alt="" src="/api/avatar/${encodeURIComponent(person.peer)}?p=${encodeURIComponent(person.photo)}"
      data-name="${esc(name)}" data-seed="${esc(seed)}">`;
  }
  return initialsHtml(name, seed, cls);
}
document.addEventListener("error", (e) => {  // hidden photo / broken image
  const img = e.target;
  if (img.tagName !== "IMG") return;
  if (img.classList.contains("av")) {
    const cls = [...img.classList].filter((c) => c !== "av").join(" ");
    img.outerHTML = initialsHtml(img.dataset.name, img.dataset.seed, cls);
  } else if (img.parentElement?.classList.contains("att")) {
    img.parentElement.classList.add("broken");
  }
}, true);
const botAv = (cls = "") => `<div class="av bot ${cls}">✦</div>`;
const meAv = (cls = "") => av({ peer: state?.me.peer, photo: state?.me.photo, name: state?.me.name || "Me" }, cls);
const chatAv = (c, cls = "s20") => av({ peer: c.id, photo: c.photo, name: c.name }, cls);
const chatGlyph = (c) => (c.kind === "channel" ? "»" : "#");
const chatLabel = (c) => (c.kind === "dm" || c.kind === "bot" ? c.name : `${chatGlyph(c)} ${c.name}`);

const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
function dayLabel(dateStr) {
  const d = dateStr.slice(0, 10);
  if (d === ymd(new Date())) return "Today";
  if (d === ymd(new Date(Date.now() - 864e5))) return "Yesterday";
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}
const minutes = (s) => Date.parse(s.replace(" ", "T") + ":00") / 60000;
const nowTime = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date());
const dayPill = (label) => `<div class="day"><span>${esc(label)}</span></div>`;
function ago(ts) {
  if (!ts) return "";
  const d = (Date.now() / 1000 - ts) / 86400;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.floor(d)} days ago` : new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// The server refuses state-changing requests without this header (blocks other websites).
const GUARD = { "X-Inbox": "1" };
async function api(path, opts = {}) {
  if (opts.method && opts.method !== "GET") opts.headers = { ...(opts.headers || {}), ...GUARD };
  const r = await fetch(path, opts);
  if (!r.ok) {
    const body = await r.text();
    let msg = body || r.statusText;
    try { const j = JSON.parse(body); msg = j.detail || j.error || msg; } catch { /* plain text */ }
    throw new Error(msg);
  }
  return r.json();
}
const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function store(key, value) {  // per-browser conveniences only; the app works without them
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

function autosize(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 200) + "px"; }
// blocked(): return true to refuse a submit (the input keeps its text).
function wireComposer(form, input, onSend, blocked = () => false) {
  input.addEventListener("input", () => { autosize(input); form.classList.toggle("has-text", !!input.value.trim()); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v || blocked()) return;
    setInput(form, input, "");
    onSend(v);
  });
}
function setInput(form, input, text) {
  input.value = text;
  autosize(input);
  form.classList.toggle("has-text", !!text.trim());
}

let toastTimer = null;
function toast(html, isErr = false, ms = 4500) {
  const t = $("#toast");
  t.innerHTML = html;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Fuzzy match for chat names: accent-insensitive; prefix > word start > substring > initials.
function score(name, q) {
  const n = fold(name);
  q = fold(q).trim();
  if (!q) return 1;
  if (n.startsWith(q)) return 100 - n.length / 100;
  const words = n.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 80 - n.length / 100;
  if (n.includes(q)) return 60 - n.indexOf(q) / 10;
  if (words.map((w) => w[0]).join("").startsWith(q.replace(/\s+/g, ""))) return 40;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}
function matchChats(q, filter = () => true, limit = 50) {
  return allChats.filter(filter)
    .map((c) => ({ c, s: score(c.name, q) + (c.username && fold(c.username).startsWith(fold(q)) ? 30 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.c.unread_count > 0) - (a.c.unread_count > 0) || b.c.last_ts - a.c.last_ts)
    .slice(0, limit).map((x) => x.c);
}

// ================================================================== state + sidebar
// One polling loop only: calling loadState() early (after an action) restarts the timer.
let pollTimer = null;
async function loadState() {
  clearTimeout(pollTimer);
  try {
    state = await api("/api/state");
    if (state.timezone) TZ = state.timezone;
  } catch {
    $("#status").innerHTML = `<span class="err">Server not reachable</span>`;
    pollTimer = setTimeout(loadState, 5000);
    return;
  }
  $("#me").innerHTML = `<span class="presence"></span>${esc(state.me.name)}`;
  $("#rail-me").innerHTML = meAv();
  $("#status").innerHTML = state.refreshing ? `<span class="spin">↻</span> Scanning Telegram…`
    : state.status !== "ready" ? `<span class="err">${esc(state.status)}</span>`
    : typeof liveOk !== "undefined" && liveOk ? `<span class="live-dot">●</span> Live` : state.snapshot_at ? `Scanned ${esc(state.snapshot_at.slice(11, 16))}` : "";
  setBadges(state.mentions_unread);
  renderSidebar();
  if (!historyRendered) {
    historyRendered = true;
    renderHistory(state.history);
    navigate({ view: "manager" });
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loadState, state.refreshing ? 4000 : 60000);
}
async function loadAllChats() {
  try { allChats = (await api("/api/chats")).chats; } catch { /* retry on next refresh */ }
}

if (/Electron/.test(navigator.userAgent)) document.body.classList.add("electron");  // AhaSlack desktop app
function setBadges(n) {
  document.title = n ? `(${n}) AhaSlack` : "AhaSlack";  // the desktop app shows this on the Dock icon
  for (const id of ["#mention-badge", "#rail-badge"]) {
    $(id).hidden = !n;
    $(id).textContent = n;
  }
}

// DMs always live under Direct messages (like Slack); "Needs you" is for groups and channels.
function sectionOf(c) {
  if (c.kind === "dm") return c.ignored || c.muted ? "quiet" : "dms";
  if (c.kind === "bot") return "quiet";  // a chat with a bot is a DM, but not a person
  if (c.tier === "must") return "must";
  if (c.tier === "noise" || c.muted || c.kind === "bot" || c.kind === "channel") return "quiet";
  return "channels";
}
const SECTIONS = [["must", "Needs you"], ["channels", "Channels"], ["dms", "Direct messages"], ["quiet", "Muted, channels & bots"]];

// Slack Standard sidebar: a Starred section, then sections sorted by priority / recent / A→Z,
// optionally showing only unreads or only mentions & DMs (saved server-side in ui prefs).
const SORTS = { priority: "Priority", recent: "Recent activity", alpha: "Alphabetical" };
const SHOWS = { all: "All conversations", unreads: "Unreads only", mentions: "Mentions & DMs only" };
const TIER_RANK = { must: 0, maybe: 1, noise: 3 };
function priorityScore(c) {
  return (c.unread_mentions ? 4 : 0) + (c.kind === "dm" && c.unread_count ? 3 : 0) + (TIER_RANK[c.tier] === 0 ? 2 : 0)
    + (c.unread_count ? 1 : 0) - (c.muted ? 2 : 0);
}
function sortChats(list) {
  const mode = uiPrefs.sort || "priority";
  if (mode === "alpha") return list.sort((a, b) => a.name.localeCompare(b.name, "vi", { sensitivity: "base" }));
  if (mode === "recent") return list.sort((a, b) => b.last_ts - a.last_ts);
  return list.sort((a, b) => priorityScore(b) - priorityScore(a) || b.last_ts - a.last_ts);
}
function showChat(c) {
  const show = uiPrefs.show || "all";
  if (show === "unreads") return c.unread_count > 0 || (view === "chat" && currentChat === c.id);
  if (show === "mentions") return c.unread_mentions > 0 || (c.kind === "dm" && c.unread_count > 0) || (view === "chat" && currentChat === c.id);
  return true;
}
const isStarred = (id) => (uiPrefs.starred || []).includes(id);

function renderSidebar() {
  if (!state) return;
  const groups = { starred: [], must: [], channels: [], dms: [], quiet: [] };
  for (const c of state.chats) {
    if ((typeof inFolder === "function" && !inFolder(c)) || !showChat(c)) continue;
    groups[isStarred(c.id) ? "starred" : sectionOf(c)].push(c);
  }
  for (const k in groups) sortChats(groups[k]);
  const filterNote = (uiPrefs.show || "all") !== "all" ? `<div class="sb-filter">Showing ${esc(SHOWS[uiPrefs.show].toLowerCase())} · <a href="#" data-show-all>show all</a></div>` : "";
  $("#sections").innerHTML = `<div class="sb-tools"><button class="sb-tool" data-sidebar-menu title="Sort and filter the sidebar">⇅ ${esc(SORTS[uiPrefs.sort || "priority"])}</button></div>` + filterNote +
    [["starred", "⭐ Starred"], ...SECTIONS].map(([key, label]) => {
    const list = groups[key];
    if (!list.length) return "";
    const limit = shown[key] ?? 12;
    const items = list.slice(0, limit).map((c) => {
      if (c.forum && topicsOf(c.id).length) return forumBlock(c);
      const badge = c.kind === "dm" ? c.unread_count : c.unread_mentions;
      const icon = c.kind === "dm" || c.kind === "bot" ? `<span class="avwrap">${chatAv(c)}</span>` : `<span class="sb-ico">${chatGlyph(c)}</span>`;
      return `<button class="sb-item ${c.unread_count ? "unread" : ""} ${c.muted || c.ignored ? "muted" : ""} ${view === "chat" && currentChat === c.id ? "active" : ""}"
        data-chat="${c.id}" title="${esc(c.why || c.name)}">${icon}<span class="nm">${esc(c.name)}</span>
        ${c.ignored ? `<span class="ign" title="Ignored">⊘</span>` : ""}${badge ? `<b class="pill">${badge > 99 ? "99+" : badge}</b>` : ""}
        <span class="more-btn" data-menu="${c.id}" title="More options" role="button">⋯</span></button>`;
    }).join("");
    const more = list.length > limit ? `<button class="more" data-more="${key}">Show ${list.length - limit} more</button>` : "";
    return `<div class="section ${collapsed[key] ? "collapsed" : ""}">
      <button class="section-head" data-toggle="${key}"><span class="caret">▼</span>${label}</button>
      <div class="section-body">${items}${more}</div></div>`;
  }).join("");
  $$(".sb-top .sb-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}

// A group with Topics: a collapsible header, then one "# topic" row per topic, like a Slack
// section of channels. Collapsed, it still lists topics that mention you, as Slack does.
const forumExpanded = (id) => (uiPrefs.forumOpen || []).includes(id);
const forumShowAll = new Set();
function sortTopics(ts) {
  const mode = uiPrefs.sort || "priority";
  const score = (t) => (t.unread_mentions ? 4 : 0) + (t.unread_count ? 1 : 0);
  return [...ts].filter((t) => !t.hidden || t.unread_count).sort((a, b) =>
    (b.pinned - a.pinned) || (mode === "alpha" ? a.title.localeCompare(b.title, "vi") : mode === "recent" ? b.last_ts - a.last_ts : score(b) - score(a) || b.last_ts - a.last_ts));
}
function forumBlock(c) {
  const open = forumExpanded(c.id);
  let ts = sortTopics(topicsOf(c.id));
  if ((uiPrefs.show || "all") === "unreads") ts = ts.filter((t) => t.unread_count || (currentChat === c.id && currentTopic === t.id));
  if ((uiPrefs.show || "all") === "mentions") ts = ts.filter((t) => t.unread_mentions || (currentChat === c.id && currentTopic === t.id));
  const shownTs = open ? (forumShowAll.has(c.id) ? ts : ts.slice(0, 10)) : ts.filter((t) => t.unread_mentions || (view === "chat" && currentChat === c.id && currentTopic === t.id));
  const head = `<button class="sb-item forum-head ${c.unread_count ? "unread" : ""} ${c.muted || c.ignored ? "muted" : ""} ${view === "chat" && currentChat === c.id && !currentTopic ? "active" : ""}"
      data-forum="${c.id}" title="${esc(c.why || c.name)} · ${topicsOf(c.id).length} topics"><span class="sb-ico caret-mini">${open ? "▾" : "▸"}</span><span class="nm">${esc(c.name)}</span>
      ${c.unread_mentions ? `<b class="pill">${c.unread_mentions > 99 ? "99+" : c.unread_mentions}</b>` : ""}
      <span class="more-btn" data-menu="${c.id}" title="More options" role="button">⋯</span></button>`;
  const rows = shownTs.map((t) => `<button class="sb-item topic-row ${t.unread_count ? "unread" : ""} ${t.closed ? "muted" : ""} ${view === "chat" && currentChat === c.id && currentTopic === t.id ? "active" : ""}"
      data-chat="${c.id}" data-topic="${t.id}" title="${esc(t.title)} · ${esc(c.name)}"><span class="sb-ico">${t.closed ? "🔒" : "#"}</span><span class="nm">${esc(t.title)}</span>
      ${t.unread_mentions ? `<b class="pill">${t.unread_mentions}</b>` : ""}</button>`).join("");
  const more = open && ts.length > shownTs.length ? `<button class="more" data-forum-more="${c.id}">Show ${ts.length - shownTs.length} more topics</button>` : "";
  return `<div class="forum">${head}${rows}${more}</div>`;
}
function toggleForum(id) {
  const set = new Set(uiPrefs.forumOpen || []);
  if (set.has(id)) set.delete(id); else set.add(id);
  uiPrefs.forumOpen = [...set];
  saveUi();
  renderSidebar();
}

function sidebarMenu(anchor) {
  const menu = $("#ctx-menu");
  const radio = (group, key, label) => `<button class="mi" data-ui="${group}:${key}">${(uiPrefs[group] || (group === "sort" ? "priority" : "all")) === key ? "✓" : "&nbsp;&nbsp;"} ${esc(label)}</button>`;
  menu.innerHTML = `<div class="mh">Sort</div>${Object.entries(SORTS).map(([k, l]) => radio("sort", k, l)).join("")}
    <div class="sep"></div><div class="mh">Show</div>${Object.entries(SHOWS).map(([k, l]) => radio("show", k, l)).join("")}`;
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = r.left + "px";
  menu.style.top = r.bottom + 4 + "px";
}
$("#ctx-menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ui]");
  if (!b) return;
  e.stopImmediatePropagation();
  const [group, key] = b.dataset.ui.split(":");
  uiPrefs[group] = key;
  closeMenu();
  saveUi();
  renderSidebar();
}, true);
function toggleStar(chatId) {
  const list = new Set(uiPrefs.starred || []);
  const on = !list.has(chatId);
  if (on) list.add(chatId); else list.delete(chatId);
  uiPrefs.starred = [...list];
  saveUi();
  renderSidebar();
  toast(on ? `⭐ Starred <b>${esc(chatById(chatId)?.name || "")}</b>` : "Removed from Starred");
}

$("#sections").addEventListener("click", (e) => {
  const fm = e.target.closest("[data-forum-more]");
  if (fm) { forumShowAll.add(Number(fm.dataset.forumMore)); return renderSidebar(); }
  const fh = e.target.closest("[data-forum]");
  if (fh && !e.target.closest("[data-menu]")) return toggleForum(Number(fh.dataset.forum));
  const sm = e.target.closest("[data-sidebar-menu]");
  if (sm) { e.stopPropagation(); return sidebarMenu(sm); }
  if (e.target.closest("[data-show-all]")) { e.preventDefault(); uiPrefs.show = "all"; saveUi(); return renderSidebar(); }
  const menuBtn = e.target.closest("[data-menu]");
  if (menuBtn) {
    e.stopPropagation();
    const r = menuBtn.getBoundingClientRect();
    return openChatMenu(Number(menuBtn.dataset.menu), r.right + 4, r.top);
  }
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.toggle) { collapsed[t.dataset.toggle] = !collapsed[t.dataset.toggle]; renderSidebar(); }
  else if (t.dataset.more) { shown[t.dataset.more] += 40; renderSidebar(); }
  else if (t.dataset.chat) navigate({ view: "chat", chatId: Number(t.dataset.chat), topic: t.dataset.topic ? Number(t.dataset.topic) : undefined });
});
$$(".sb-top .sb-item").forEach((b) => b.addEventListener("click", () => navigate({ view: b.dataset.view })));
$$(".rail-btn").forEach((b) => b.addEventListener("click", () => {
  const r = b.dataset.rail;
  if (r === "home") $("#sidebar").classList.add("open");
  else navigate({ view: r });
}));
$("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#refresh").addEventListener("click", async () => {
  await api("/api/refresh", { method: "POST" });
  $("#status").innerHTML = `<span class="spin">↻</span> Scanning Telegram…`;
  setTimeout(() => { loadState(); loadAllChats(); }, 1500);
});

const chatById = (id) => state?.chats.find((c) => c.id === id) || allChats.find((c) => c.id === id);

// ================================================================== chat menu (⋯ / right-click): ignore, mark read, details
function openChatMenu(chatId, x, y) {
  const c = chatById(chatId);
  if (!c) return;
  const menu = $("#ctx-menu");
  const isGroup = c.kind !== "dm";
  menu.innerHTML = `<div class="mh">${esc(chatLabel(c))}</div>
    <button class="mi" data-m="open">${c.forum ? "Open all topics together" : "Open conversation"}</button>
    ${c.forum ? `<button class="mi" data-m="forum">${forumExpanded(chatId) ? "Collapse topics" : "Show topics"}</button>` : ""}
    <button class="mi" data-m="details">Conversation details<span class="k">${plainCombo(bindingOf(action("details")))}</span></button>
    ${state.mark_read_enabled && c.unread_count ? `<button class="mi" data-m="read">Mark as read<span class="k">Esc</span></button>` : ""}
    <button class="mi" data-m="star">${isStarred(chatId) ? "Remove from Starred" : "⭐ Star conversation"}</button>
    <button class="mi" data-m="summarize">✦ Summarize with manager</button>
    <div class="sep"></div>
    ${c.ignored ? `<button class="mi" data-m="unignore">Stop ignoring</button>`
      : `<button class="mi" data-m="ignore">${isGroup ? "Ignore this group (remove from Needs you)" : "Ignore this conversation"}</button>`}
    ${c.link && c.link.startsWith("http") ? `<button class="mi" data-m="tg">Open in Telegram ↗</button>` : ""}`;
  menu.dataset.chat = chatId;
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
}
function closeMenu() { $("#ctx-menu").hidden = true; }
$("#sections").addEventListener("contextmenu", (e) => {
  const item = e.target.closest(".sb-item[data-chat]");
  if (!item) return;
  e.preventDefault();
  openChatMenu(Number(item.dataset.chat), e.clientX, e.clientY);
});
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctx-menu") && !e.target.closest("[data-menu]")) closeMenu(); });
$("#ctx-menu").addEventListener("click", async (e) => {
  const mi = e.target.closest("[data-m]");
  if (!mi) return;
  const id = Number($("#ctx-menu").dataset.chat);
  const c = chatById(id);
  closeMenu();
  const m = mi.dataset.m;
  if (m === "open") navigate({ view: "chat", chatId: id });
  else if (m === "forum") toggleForum(id);
  else if (m === "details") openDetails(id);
  else if (m === "read") markRead(id);
  else if (m === "star") toggleStar(id);
  else if (m === "summarize") { if (view !== "chat" || currentChat !== id) navigate({ view: "chat", chatId: id }); setTimeout(summarizeChat, 50); }
  else if (m === "ignore" || m === "unignore") setIgnored(id, m === "ignore");
  else if (m === "tg") window.open(c.link, "_blank", "noopener");
});

async function setIgnored(chatId, ignored) {
  const c = chatById(chatId);
  try {
    await postJson(`/api/chat/${chatId}/ignore`, { ignored });
  } catch (e) { return toast(`Couldn't update: ${esc(e.message)}`, true); }
  for (const list of [state.chats, allChats]) {
    const x = list.find((y) => y.id === chatId);
    if (x) { x.ignored = ignored; if (ignored) { x.tier = "noise"; x.why = "ignored by you"; } }
  }
  renderSidebar();
  if (mentionData) { mentionData.items = mentionData.items.filter((m) => !ignored || m.chat.id !== chatId); if (view === "mentions") loadMentions(); }
  toast(ignored ? `Ignoring <b>${esc(c?.name)}</b>: it won't show in Needs you or Mentions. <a href="#" data-undo-ignore="${chatId}">Undo</a>`
    : `<b>${esc(c?.name)}</b> is back. It shows up again after the next scan.`, false, 7000);
  setTimeout(loadState, 800);
}
$("#toast").addEventListener("click", (e) => {
  const u = e.target.closest("[data-undo-ignore]");
  if (u) { e.preventDefault(); setIgnored(Number(u.dataset.undoIgnore), false); }
});

function confirmBox(title, text, okLabel = "OK") {
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").innerHTML = text;
    $("#confirm-yes").textContent = okLabel;
    $("#confirm").hidden = false;
    $("#confirm-yes").focus();
    const done = (v) => { $("#confirm").hidden = true; $("#confirm-yes").onclick = $("#confirm-no").onclick = null; resolve(v); };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
    confirmBox.cancel = () => done(false);
  });
}

async function markRead(chatId, quiet = false, { auto = false } = {}) {
  if (!state.mark_read_enabled) return quiet || toast("Marking as read is off (mark_read_enabled in config.toml)", true);
  const c = chatById(chatId);
  if (!c || (!c.unread_count && !c.unread_mentions)) return quiet || toast(`${esc(c?.name || "This chat")} is already read`);
  try {
    const topicQ = chatId === currentChat && currentTopic ? `?topic=${currentTopic}` : "";
    await api(`/api/chat/${chatId}/read${topicQ}`, { method: "POST" });
  } catch (e) { return toast(`Couldn't mark as read: ${esc(e.message)}`, true); }
  const tp = chatId === currentChat && currentTopic ? topicById(chatId, currentTopic) : null;
  for (const list of [state.chats, allChats]) {
    const x = list.find((y) => y.id === chatId);
    if (!x) continue;
    if (tp) { x.unread_count = Math.max(0, x.unread_count - tp.unread_count); x.unread_mentions = Math.max(0, x.unread_mentions - tp.unread_mentions); }
    else x.unread_count = x.unread_mentions = 0;
  }
  if (tp) tp.unread_count = tp.unread_mentions = 0;
  renderSidebar();
  if (currentChat === chatId && view === "chat") {
    $("#ch-topic").textContent = $("#ch-topic").textContent.replace(/\d+ unread/, "all read");
    $("#unread-banner")?.remove();
    if (!auto) { $(".new-line")?.remove(); chatMeta.unread = 0; }
  }
  if (!auto) toast(`✓ Marked <b>${esc(c.name)}</b> as read`);
}
async function markAllRead() {
  if (!state.mark_read_enabled) return toast("Marking as read is off (mark_read_enabled in config.toml)", true);
  const n = state.chats.filter((c) => c.unread_count).length;
  if (!n) return toast("Everything is already read");
  const ok = await confirmBox("Mark all messages as read?", `This marks <b>${n}</b> conversations as read on Telegram. People in them may see that you've read their messages.`, "Mark all as read");
  if (!ok) return;
  toast("Marking everything as read…", false, 30000);
  try {
    const r = await api("/api/read-all", { method: "POST" });
    toast(`✓ Marked ${r.count} conversations as read`);
  } catch (e) { toast(`Couldn't mark all as read: ${esc(e.message)}`, true); }
  loadState();
  loadAllChats();
}

async function openDetails(chatId = currentChat) {
  const c = chatById(chatId);
  if (!c) return;
  const kind = c.kind === "dm" ? "Direct message" : c.kind === "bot" ? "Bot" : c.kind === "channel" ? "Broadcast channel" : "Group";
  const tierName = { must: "Needs you", maybe: "Worth a look", noise: "Ignorable" }[c.tier] || "Read";
  $("#details-title").textContent = c.kind === "dm" ? c.name : `${chatGlyph(c)} ${c.name}`;
  $("#details-body").innerHTML = `<div class="top">${chatAv(c, "")}<div><div class="who">${esc(c.name)}</div><div class="sub">${esc(kind)}${c.username ? ` · @${esc(c.username)}` : ""}</div></div></div>
    <dl><dt>Status</dt><dd>${esc(tierName)}${c.why ? ` · ${esc(c.why)}` : ""}</dd>
    <dt>Unread</dt><dd>${c.unread_count || 0} messages${c.unread_mentions ? `, ${c.unread_mentions} mentions` : ""}</dd>
    <dt>Notifications</dt><dd>${c.muted ? "Muted" : "On"}${c.ignored ? " · ignored in this app" : ""}</dd>
    <dt>Last activity</dt><dd>${esc(ago(c.last_ts))}</dd>
    <dt>Chat id</dt><dd><code>${c.id}</code></dd></dl>
    <div class="row-btns">
      <button class="btn" data-d="search">⌕ Search in conversation</button>
      <button class="btn" data-d="summarize">✦ Summarize</button>
      ${state.mark_read_enabled && c.unread_count ? `<button class="btn" data-d="read">Mark as read</button>` : ""}
      <button class="btn" data-d="ignore">${c.ignored ? "Stop ignoring" : "Ignore"}</button>
      ${c.link && c.link.startsWith("http") ? `<a class="btn ext" href="${esc(c.link)}" target="_blank" rel="noopener">Open in Telegram ↗</a>` : ""}
    </div>`;
  $("#details").dataset.chat = chatId;
  $("#details").hidden = false;
}
const closeDetails = () => { $("#details").hidden = true; };
$("#details").addEventListener("click", (e) => {
  if (e.target.id === "details" || e.target.closest("[data-close]")) return closeDetails();
  const d = e.target.closest("[data-d]")?.dataset.d;
  const id = Number($("#details").dataset.chat);
  if (!d) return;
  closeDetails();
  if (d === "search") { if (currentChat !== id || view !== "chat") navigate({ view: "chat", chatId: id }); setTimeout(() => focusSearch(true), 60); }
  else if (d === "summarize") { if (currentChat !== id || view !== "chat") navigate({ view: "chat", chatId: id }); setTimeout(summarizeChat, 60); }
  else if (d === "read") markRead(id);
  else if (d === "ignore") setIgnored(id, !chatById(id)?.ignored);
});

// ================================================================== all unreads (Cmd+Shift+A)
let unreadItems = [];
async function loadUnreads() {
  header(`<span class="hash">≡</span><h1>All unreads</h1><span class="topic">Every conversation with new messages</span>`,
    state.mark_read_enabled ? `<button class="btn" data-act="read-all">✓ <span class="lbl">Mark all as read</span></button>` : "");
  const feed = $("#unreads-feed");
  feed.innerHTML = `<div class="loading">Loading…</div>`;
  try { unreadItems = (await api("/api/unreads")).items; } catch (e) { feed.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
  if (view !== "unreads") return;
  if (!unreadItems.length) { feed.innerHTML = `<div class="empty"><div class="big">🎉</div>You're all caught up.</div>`; return; }
  feed.innerHTML = unreadItems.map((u, i) => {
    const c = u.chat;
    let prev = null;
    const rows = u.messages.map((m) => { const h = msgRow(m, prev); prev = m; return h; }).join("");
    const more = c.unread_count > u.messages.length ? `<div class="ur-more" data-open="${c.id}">${c.unread_count - u.messages.length} more unread ›</div>` : "";
    return `<div class="ur-group" data-i="${i}"><div class="ur-head">${c.kind === "dm" || c.kind === "bot" ? chatAv(c, "s20") : `<span class="sb-ico">${chatGlyph(c)}</span>`}
      <span class="nm" data-open="${c.id}">${esc(c.name)}</span><span class="sub">${c.unread_count} unread${u.tier === "must" ? " · needs you" : ""}${c.muted ? " · muted" : ""}</span><span class="sp"></span>
      ${state.mark_read_enabled ? `<button class="btn" data-read="${c.id}">Mark as read</button>` : ""}</div>${rows || `<div class="ur-more" data-open="${c.id}">Open to read ›</div>`}${more}</div>`;
  }).join("");
}
$("#unreads-feed").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) return navigate({ view: "chat", chatId: Number(open.dataset.open) });
  const rd = e.target.closest("[data-read]");
  if (rd) { await markRead(Number(rd.dataset.read)); rd.closest(".ur-group").remove(); return; }
  const msg = e.target.closest(".msg");
  if (msg && !e.target.closest("a") && !e.target.closest(".att")) {
    const g = unreadItems[Number(msg.closest(".ur-group").dataset.i)];
    navigate({ view: "chat", chatId: g.chat.id, focus: Number(msg.dataset.id) });
  }
});

// ================================================================== navigation + history (Cmd+[ / Cmd+])
const nav = { stack: [], index: -1 };
function sameEntry(a, b) { return a && b && a.view === b.view && a.chatId === b.chatId && a.topic === b.topic && a.focus === b.focus && a.q === b.q && a.scope === b.scope; }
function navigate(entry, push = true) {
  if (push && !sameEntry(nav.stack[nav.index], entry)) {
    nav.stack = nav.stack.slice(0, nav.index + 1);
    nav.stack.push(entry);
    nav.index = nav.stack.length - 1;
  }
  $("#nav-back").disabled = nav.index <= 0;
  $("#nav-fwd").disabled = nav.index >= nav.stack.length - 1;
  if (entry.view === "chat") openChat(entry.chatId, { focus: entry.focus, topic: entry.topic });
  else if (entry.view === "search") runSearch(entry.q, entry.scope);
  else { setView(entry.view); if (entry.view === "mentions") loadMentions(); if (entry.view === "unreads") loadUnreads(); }
}
function goBack() { if (nav.index > 0) { nav.index--; navigate(nav.stack[nav.index], false); } }
function goForward() { if (nav.index < nav.stack.length - 1) { nav.index++; navigate(nav.stack[nav.index], false); } }
$("#nav-back").addEventListener("click", goBack);
$("#nav-fwd").addEventListener("click", goForward);

function setView(name) {
  view = name;
  for (const v of ["manager", "chat", "mentions", "search", "unreads", "more", "files"]) $("#view-" + v).hidden = v !== name;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active",
    b.dataset.rail === (name === "mentions" ? "mentions" : name === "manager" ? "manager" : "home")));
  $("#sidebar").classList.remove("open");
  $("#banner").hidden = true;
  if (name !== "chat") setScope(null);
  if (name === "manager") {
    closePane();
    header(`${botAv("s24")}<h1>Inbox Manager</h1><span class="app-tag">APP</span><span class="topic">Reads your Telegram for you · read-only</span>`,
      `<button class="btn" data-act="new-convo">＋ <span class="lbl">New conversation</span></button>`);
  } else if (name === "mentions") {
    header(`<span class="hash">@</span><h1>Mentions &amp; replies</h1><span class="topic">Click one to jump to it in its chat</span>`,
      `<button class="btn" data-act="done-all">✓ <span class="lbl">Mark all as read</span></button><button class="btn" data-act="summarize-mentions">✦ <span class="lbl">Summarize</span></button><button class="btn" data-act="recheck">↻ <span class="lbl">Re-check</span></button>`);
  }
  mountManager();
  renderSidebar();
  if (name === "manager") setTimeout(() => $("#input").focus(), 0);
}

function header(title, actions = "") {
  $("#ch-title").innerHTML = title;
  $("#ch-actions").innerHTML = actions;
}

$("#ch-actions").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "new-convo") {
    if (busy) return;
    await api("/api/reset", { method: "POST" });
    renderHistory([]);
  } else if (act === "recheck") {
    loadMentions(true);
  } else if (act === "done-all") {
    markAllDone();
  } else if (act === "read-all") {
    markAllRead();
  } else if (act === "summarize-mentions") {
    askInPane(`Summarize my unread mentions and replies: who wants what from me, grouped by urgency, with links. Skip ones already resolved in the thread.`, "Mentions & replies");
  } else if (act === "summarize-chat") {
    summarizeChat();
  } else if (act === "ask-search") {
    askInPane(`Search my Telegram for "${lastSearch.q}"${lastSearch.scope ? ` in "${chatById(lastSearch.scope)?.name}" (chat_id ${lastSearch.scope})` : ""} and summarize what you find.`, `“${lastSearch.q}”`);
  }
});
function summarizeChat() {
  if (view !== "chat") return;
  const c = chatById(currentChat);
  askInPane(`Summarize what's happening in "${c?.name}" (chat_id ${currentChat}) and tell me what, if anything, needs me.`, c?.name);
}

// ================================================================== manager (main view or thread pane)
function mountManager() {
  const box = $("#manager-box");
  const target = view === "manager" ? $("#manager-mount") : !$("#pane").hidden ? $("#pane-mount") : null;
  if (target && box.parentElement !== target) target.appendChild(box);
  if (!target) document.body.appendChild(box);
  box.hidden = !target;
  const t = $("#thread");
  t.scrollTop = t.scrollHeight;
}
function openPane(sub) {
  $("#pane").hidden = false;
  $("#pane-sub").textContent = sub ? `Inbox Manager · ${sub}` : "Inbox Manager";
  mountManager();
}
function closePane() { $("#pane").hidden = true; mountManager(); }
function togglePane() {
  if (view === "manager") return;
  if ($("#pane").hidden) openPane(chatById(currentChat)?.name); else closePane();
}
$("#pane-close").addEventListener("click", closePane);

function askInPane(prompt, sub) {
  if (view !== "manager") openPane(sub);
  ask(prompt);
}

function renderHistory(history) {
  const thread = $("#thread");
  thread.innerHTML = "";
  if (!history.length) {
    thread.innerHTML = `<div class="hello">${botAv()}<h2>Inbox Manager</h2>
      <p>Hi${state ? " " + esc(state.me.name.split(" ")[0]) : ""}! I read your Telegram for you (read-only). Ask me what needs you, who tagged you, or what happened in any chat.</p></div>`;
  }
  for (const m of history) {
    if (m.role === "user") addUserMsg(m.text, "");
    else addBotMsg(m.text, m.tools, "");
  }
  $("#suggestions").hidden = history.length > 0;
  thread.scrollTop = thread.scrollHeight;
}

function addUserMsg(text, when = nowTime()) {
  $(".hello")?.remove();
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `${meAv()}<div class="msg-body"><div class="msg-head"><span class="who">${esc(state?.me.name || "You")}</span><span class="when">${when}</span></div>
    <div class="msg-text">${linkify(esc(text)).replace(/\n/g, "<br>")}</div></div>`;
  $("#thread").appendChild(el);
  return el;
}

function addBotMsg(text, tools = [], when = nowTime()) {
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `${botAv()}<div class="msg-body"><div class="msg-head"><span class="who">Inbox Manager</span><span class="app-tag">APP</span><span class="when">${when}</span></div>
    <div class="tools">${tools.map((t) => `<span class="tool-chip">${esc(Array.isArray(t) ? toolLabel(t[0], t[1]) : toolLabel(t))}</span>`).join("")}</div>
    <div class="msg-text">${md(text)}</div></div>`;
  $("#thread").appendChild(el);
  return el;
}

const TOOL_LABELS = { overview: "Checked inbox overview", mentions: "Read mentions", read_chat: "Read",
  message_context: "Looked at a message", search: "Searched", refresh: "Refreshed inbox" };
function toolLabel(name, input) {
  let label = TOOL_LABELS[name] || name;
  try {
    const a = input ? JSON.parse(input) : {};
    const chatName = (ref) => chatById(Number(ref))?.name || ref;
    if (a.chat) label += ` ${chatName(a.chat)}`;
    else if (a.chat_id) label += ` in ${chatName(a.chat_id)}`;
    if (a.query) label += ` “${a.query}”`;
  } catch { /* keep the generic label */ }
  return label;
}

async function ask(prompt) {
  if (!prompt.trim() || busy) return;
  busy = true;
  $("#send").disabled = true;
  $("#suggestions").hidden = true;
  addUserMsg(prompt);
  const bot = addBotMsg("");
  const textEl = $(".msg-text", bot);
  const toolsEl = $(".tools", bot);
  textEl.innerHTML = `<span class="typing">Thinking…</span>`;
  const thread = $("#thread");
  thread.scrollTop = thread.scrollHeight;
  let text = "";
  let pending = false;
  const paint = () => {
    pending = false;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    textEl.innerHTML = md(text);
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
  };
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json", ...GUARD }, body: JSON.stringify({ message: prompt }) });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === "text") {
          text += ev.text;
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (ev.type === "tool") {
          $$(".live", toolsEl).forEach((c) => c.classList.remove("live"));
          toolsEl.insertAdjacentHTML("beforeend", `<span class="tool-chip live">${esc(toolLabel(ev.name, ev.input))}</span>`);
          if (!text) textEl.innerHTML = "";
        } else if (ev.type === "error") {
          textEl.insertAdjacentHTML("afterend", `<div class="err">⚠ ${esc(ev.text)}</div>`);
        }
      }
    }
  } catch (e) {
    textEl.insertAdjacentHTML("afterend", `<div class="err">⚠ ${esc(e.message)}</div>`);
  } finally {
    $$(".live", toolsEl).forEach((c) => c.classList.remove("live"));
    paint();
    if (!text) textEl.innerHTML = "";
    busy = false;
    $("#send").disabled = false;
  }
}

wireComposer($("#composer"), $("#input"), (v) => ask(v), () => busy);
$("#suggestions").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") ask(e.target.textContent); });

// ================================================================== sending (only ever by the user)
// UNDO_MS > 0 shows a countdown with Undo first; 0 sends right away.
// Resolves with the sent message, or null if the user pressed Undo.
function sendMessage(host, chatId, text, replyTo) {
  return new Promise((resolve, reject) => {
    const name = chatById(chatId)?.name || "chat";
    const el = document.createElement("div");
    el.className = "pending";
    el.innerHTML = UNDO_MS > 0
      ? `<span class="lbl">Sending to <b>${esc(name)}</b>…</span><span class="bar"><i></i></span><button type="button">Undo</button>`
      : `<span class="lbl"><span class="spin">◌</span> Sending…</span>`;
    host.appendChild(el);
    const go = async () => {
      $("button", el)?.setAttribute("disabled", "");
      $(".lbl", el).textContent = "Sending…";
      try {
        resolve((await postJson(`/api/chat/${chatId}/send`, { text, reply_to: replyTo || null, topic: chatId === currentChat ? currentTopic : null })).message);
      } catch (e) {
        reject(e);
      } finally {
        el.remove();
      }
    };
    if (UNDO_MS <= 0) return go();
    const bar = $(".bar i", el);
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transitionDuration = UNDO_MS + "ms"; bar.style.width = "100%"; }));
    const timer = setTimeout(go, UNDO_MS);
    $("button", el).addEventListener("click", () => { clearTimeout(timer); el.remove(); resolve(null); });
  });
}
const SEND_HINT = UNDO_MS > 0 ? `Enter to send · ${UNDO_MS / 1000}s to undo` : "Enter to send · Shift+Enter for a new line";

// ================================================================== message rows
function imageHtml(m) {
  const im = m.image;
  if (!im || m.chat_id == null) return "";
  const sticker = ["sticker", "lottie", "vsticker"].includes(im.kind);
  const box = sticker ? [160, 160] : [380, 300];
  let w = im.w || 300, h = im.h || 220;
  const s = Math.min(1, box[0] / w, box[1] / h);
  w = Math.round(w * s); h = Math.round(h * s);
  const who = m.out ? state.me.name : m.sender?.name || "";
  if (im.kind === "lottie") return `<div class="att sticker"><div class="lottie" style="width:${w}px;height:${h}px" data-lottie="/api/media/${m.chat_id}/${m.id}"></div></div>`;
  if (im.kind === "vsticker") return `<div class="att sticker"><video width="${w}" height="${h}" src="/api/media/${m.chat_id}/${m.id}" autoplay loop muted playsinline></video></div>`;
  return `<div class="att ${im.kind}" data-img="${m.chat_id}:${m.id}" data-who="${esc(who)}" data-when="${esc(m.date)}" ${m.link ? `data-link="${esc(m.link)}"` : ""}>
    <img loading="lazy" alt="" width="${w}" height="${h}" src="/api/media/${m.chat_id}/${m.id}"></div>`;
}

// m: message dict from the server. prev: previous message (for grouping).
function msgRow(m, prev, { actions = "", tag = "", cls = "", highlight = "", after = "", before = "" } = {}) {
  const person = m.out ? { peer: state.me.peer, photo: state.me.photo, name: state.me.name } : { peer: m.sender.peer, photo: m.sender.photo, name: m.sender.name };
  const cont = prev && !cls && prev.date.slice(0, 10) === m.date.slice(0, 10) && !!prev.out === !!m.out &&
    (m.out || prev.sender?.peer === m.sender?.peer) && minutes(m.date) - minutes(prev.date) <= 5 && !tag;
  const time = esc(m.date.slice(11));
  const timeLink = m.link ? `<a class="when ext" href="${esc(m.link)}" target="_blank" rel="noopener" title="Open in Telegram">${time}</a>` : `<span class="when">${time}</span>`;
  const bar = actions ? `<div class="hover-bar">${actions}</div>` : "";
  const img = imageHtml(m);
  const edited = m.edited ? ` <span class="edited">(edited)</span>` : "";
  const text = (m.text || (!img && m.media)) ? `<div class="tg-text">${tgText(m.text, img ? null : m.media, highlight)}${edited}</div>` : "";
  const reacts = (m.reactions || []).length ? `<div class="reacts">${m.reactions.map((r) =>
    `<button class="react-chip ${r.mine ? "mine" : ""}" data-emo="${esc(r.emoji)}" title="${r.mine ? "Remove your reaction" : "React with " + esc(r.emoji)}">${esc(r.emoji)} <b>${r.count}</b></button>`).join("")}</div>` : "";
  const pin = m.pinned ? `<div class="pin-tag">📌 Pinned</div>` : "";
  const body = `${pin}${before}${text}${img}${reacts}${after}`;
  if (cont) {
    return `<div class="msg cont ${cls}" data-id="${m.id}"><div class="gutter">${time}</div><div class="msg-body">${body}</div>${bar}</div>`;
  }
  return `<div class="msg ${cls}" data-id="${m.id}">${av(person)}<div class="msg-body">
    <div class="msg-head"><span class="who">${esc(person.name)}${m.out ? " (you)" : ""}</span>${tag}${timeLink}</div>${body}</div>${bar}</div>`;
}

// ================================================================== images: viewer
let lbItem = null;
document.addEventListener("click", (e) => {
  const att = e.target.closest(".att");
  if (!att || att.classList.contains("sticker")) return;
  e.preventDefault();
  if (att.classList.contains("video")) {  // play it in Telegram
    if (att.dataset.link) window.open(att.dataset.link, "_blank", "noopener");
    else toast("Videos play in Telegram");
    return;
  }
  const [chatId, msgId] = att.dataset.img.split(":");
  lbItem = { chatId, msgId, who: att.dataset.who || "", when: att.dataset.when || "", link: att.dataset.link };
  $("#lb-img").src = `/api/media/${chatId}/${msgId}`;
  const c = chatById(Number(chatId));
  $("#lb-meta").innerHTML = `<b>${esc(lbItem.who)}</b> · ${esc(c ? chatLabel(c) : "")} · ${esc(lbItem.when)}`;
  $("#lb-actions").innerHTML = `<a href="/api/media/${chatId}/${msgId}" download="telegram-${chatId}-${msgId}">⤓ Download</a>
    ${lbItem.link ? `<a class="ext" href="${esc(lbItem.link)}" target="_blank" rel="noopener">Open in Telegram ↗</a>` : ""}<button data-close>✕</button>`;
  $("#lightbox").hidden = false;
});
$("#lightbox").addEventListener("click", (e) => {
  if (e.target.id === "lightbox" || e.target.closest("[data-close]")) $("#lightbox").hidden = true;
});

// ================================================================== t.me links open inside the app
function parseTgLink(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/^(www\.)?t\.me$/.test(u.hostname)) return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (p[0] === "c" && /^\d+$/.test(p[1] || "")) {
    const chatId = Number("-100" + p[1]);
    const msg = Number(p[p.length - 1]);
    return { chatId, focus: p.length >= 3 && Number.isFinite(msg) ? msg : undefined, topic: p.length >= 4 ? Number(p[2]) : undefined };
  }
  if (p[0] && !["joinchat", "+", "addstickers", "share", "proxy"].includes(p[0]) && !p[0].startsWith("+")) {
    const c = allChats.find((x) => x.username && x.username.toLowerCase() === p[0].toLowerCase());
    if (!c) return null;
    const msg = Number(p[p.length - 1]);
    return { chatId: c.id, focus: p.length >= 2 && Number.isFinite(msg) ? msg : undefined };
  }
  return null;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || a.classList.contains("ext") || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const t = parseTgLink(a.href);
  if (!t || !chatById(t.chatId)) return;  // not one of your chats: let Telegram open it
  e.preventDefault();
  navigate({ view: "chat", chatId: t.chatId, focus: t.focus, topic: t.topic });
});

// ================================================================== one chat
let chatMessages = [];
let chatMeta = { hasOlder: false, hasNewer: false, readUpto: 0, unread: 0, loadingOlder: false };

let currentTopic = null;  // a forum topic (Telegram Topics shown as Slack channels), or null for the whole chat
const topicsOf = (chatId) => state?.topics?.[String(chatId)] || [];
const topicById = (chatId, topicId) => topicsOf(chatId).find((t) => t.id === topicId);
async function openChat(id, { focus, topic } = {}) {
  currentChat = id;
  currentTopic = topic || null;
  const c = chatById(id) || { id, name: "Chat", kind: "group" };
  const t = currentTopic ? topicById(id, currentTopic) : null;
  setView("chat");
  remember(id);
  const icon = c.kind === "dm" || c.kind === "bot" ? chatAv(c, "s24") : `<span class="hash">${chatGlyph(c)}</span>`;
  header(currentTopic
      ? `<span class="hash">#</span><h1>${esc(t?.title || "Topic")}</h1><span class="topic" id="ch-topic"></span>`
      : `${icon}<h1>${esc(c.name)}</h1><span class="topic" id="ch-topic"></span>`,
    `<button class="btn" data-act="summarize-chat">✦ <span class="lbl">Summarize</span></button>`);
  replyTo = null;
  chatMessages = [];
  updateComposer();
  if (c.why) {
    const tierName = { must: "Needs you", maybe: "Worth a look", noise: "Ignorable" }[c.tier] || "";
    $("#banner").innerHTML = `<b>${esc(tierName)}</b> · ${esc(c.why)}`;
    $("#banner").hidden = c.tier !== "must";
  }
  $("#jump-latest").hidden = true;
  const feed = $("#chat-feed");
  feed.innerHTML = `<div class="loading">Reading from Telegram…</div>`;
  let data;
  try {
    data = await api(`/api/chat/${id}?limit=60${focus ? `&around=${focus}` : ""}${currentTopic ? `&topic=${currentTopic}` : ""}`);
  } catch (e) {
    feed.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
    return;
  }
  if (currentChat !== id || view !== "chat" || (currentTopic || null) !== (topic || null)) return;
  const ch = data.chat;
  const unread = currentTopic ? data.topic?.unread_count || 0 : ch.unread_count;
  $("#ch-topic").textContent = currentTopic
    ? [`in ${ch.name}`, unread ? `${unread} unread` : "all read", data.topic?.closed ? "closed" : ""].filter(Boolean).join(" · ")
    : [ch.kind === "dm" ? "Direct message" : ch.forum ? `group · ${topicsOf(id).length} topics` : ch.kind, ch.unread_count ? `${ch.unread_count} unread` : "all read", ch.muted ? "muted" : ""].filter(Boolean).join(" · ");
  if (ch.link && ch.link.startsWith("http")) {
    $("#ch-actions").insertAdjacentHTML("beforeend", `<a class="btn ext" href="${esc(ch.link)}" target="_blank" rel="noopener">↗ <span class="lbl">Open in Telegram</span></a>`);
  }
  chatMessages = data.messages;
  chatMeta = { hasOlder: data.has_older, hasNewer: data.has_newer, readUpto: data.read_upto, unread, loadingOlder: false };
  renderChatFeed();
  $("#jump-latest").hidden = !chatMeta.hasNewer;
  const target = focus && $(`.msg[data-id="${focus}"]`, feed);
  if (pendingJumpUnread) {  // ⌘J landed: show the "New" line, not the last read message
    pendingJumpUnread = false;
    const line = $(".new-line", feed);
    if (line) return line.scrollIntoView({ block: "start" });
  }
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("focus");
  } else {
    if (focus) { feed.scrollTop = feed.scrollHeight; toast("That message is no longer available", true); }
    else applyReadMode(id);
  }
}

function renderChatFeed() {
  const feed = $("#chat-feed");
  let day = null;
  let marked = false;
  let prev = null;
  const html = chatMessages.map((m) => {
    let out = "";
    const label = dayLabel(m.date);
    if (label !== day) { out += dayPill(label); day = label; prev = null; }
    if (!marked && !m.out && m.id > chatMeta.readUpto && chatMeta.unread) {
      marked = true;
      // Only where the unread messages really begin: not at the top of a page that starts mid-unread.
      if (m !== chatMessages[0] || !chatMeta.hasOlder) { out += `<div class="new-line"><span>New</span></div>`; prev = null; }
    }
    out += chatRow(m, prev);
    prev = m;
    return out;
  }).join("");
  const top = chatMeta.hasOlder ? `<div class="older-loader">${chatMeta.loadingOlder ? "Loading older messages…" : "Scroll up for older messages"}</div>` : "";
  feed.innerHTML = html ? top + html : `<div class="empty">No messages.</div>`;
}

async function loadOlder() {
  if (!chatMeta.hasOlder || chatMeta.loadingOlder || !chatMessages.length || view !== "chat") return;
  chatMeta.loadingOlder = true;
  const id = currentChat;
  const feed = $("#chat-feed");
  const loader = $(".older-loader", feed);
  if (loader) loader.textContent = "Loading older messages…";
  try {
    const data = await api(`/api/chat/${id}?limit=50&before=${chatMessages[0].id}${currentTopic ? `&topic=${currentTopic}` : ""}`);
    if (currentChat !== id) return;
    const oldHeight = feed.scrollHeight;
    const oldTop = feed.scrollTop;
    chatMessages = [...data.messages, ...chatMessages];
    chatMeta.hasOlder = data.has_older;
    chatMeta.loadingOlder = false;
    renderChatFeed();
    feed.scrollTop = oldTop + (feed.scrollHeight - oldHeight);
  } catch (e) {
    chatMeta.loadingOlder = false;
    toast(`Couldn't load older messages: ${esc(e.message)}`, true);
  }
}
$("#chat-feed").addEventListener("scroll", (e) => { if (e.target.scrollTop < 300) loadOlder(); });
$("#jump-latest").addEventListener("click", () => navigate({ view: "chat", chatId: currentChat, topic: currentTopic || undefined }));

function chatRow(m, prev, cls = "") {
  const flags = m.flags || [];
  const tag = flags.includes("reply_to_me") ? `<span class="tag reply">REPLY TO YOU</span>`
    : flags.includes("mention") ? `<span class="tag mention">MENTIONS YOU</span>` : "";
  const actions = (state.sending_enabled ? `<button data-react-msg="${m.id}" title="Add reaction (R)">☺</button><button data-reply="${m.id}" title="Reply in Telegram (T)">↩ Reply</button>` : "") +
    `<button data-ask="${m.id}" title="Ask Inbox Manager about this message">✦ Ask</button>` +
    (m.link ? `<a class="ext" href="${esc(m.link)}" target="_blank" rel="noopener">↗ Open</a>` : "") +
    `<button data-msgmenu="${m.id}" title="More actions">⋯</button>`;
  const target = m.reply_to && chatMessages.find((x) => x.id === m.reply_to);
  const before = m.reply_to
    ? `<div class="reply-ref" data-jump="${m.reply_to}" title="Jump to the original message">↩ ${target
      ? `<b>${esc(target.out ? "You" : target.sender.name)}</b> ${esc((target.text || target.media || "").slice(0, 90))}` : "a message"}</div>` : "";
  return msgRow(m, prev, { actions, tag, before, cls });
}

$("#chat-feed").addEventListener("click", (e) => {
  const c = chatById(currentChat);
  const jump = e.target.closest("[data-jump]");
  if (jump) {
    const id = Number(jump.dataset.jump);
    const row = $(`#chat-feed .msg[data-id="${id}"]`);
    if (row) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.classList.remove("focus"); void row.offsetWidth; row.classList.add("focus"); }
    else navigate({ view: "chat", chatId: currentChat, focus: id });
    return;
  }
  const rx = e.target.closest("[data-react-msg]");
  if (rx) {
    const m = chatMessages.find((x) => x.id === Number(rx.dataset.reactMsg));
    if (m) reactPicker(m, rx);
    return;
  }
  const r = e.target.closest("[data-reply]");
  if (r) {
    const m = chatMessages.find((x) => x.id === Number(r.dataset.reply));
    if (m) setReply(m);
    return;
  }
  const b = e.target.closest("[data-ask]");
  if (b) askInPane(`Explain this message and what (if anything) I should do: chat_id ${currentChat}, message_id ${b.dataset.ask} in "${c?.name}".`, c?.name);
});

// Chat composer: "Message" sends to Telegram; "✦ Ask Manager" opens a manager thread.
let composeMode = "send";
let replyTo = null;
function updateComposer() {
  const c = chatById(currentChat);
  const t = currentTopic ? topicById(currentChat, currentTopic) : null;
  const name = t ? `#${t.title}` : c ? `${c.kind === "dm" ? "" : "#"}${c.name}` : "this chat";
  if (!state?.sending_enabled) composeMode = "ask";
  $('#compose-mode [data-mode="send"]').hidden = !state?.sending_enabled;
  $$("#compose-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === composeMode));
  const form = $("#chat-composer");
  form.classList.toggle("ask-mode", composeMode === "ask");
  $("#chat-input").placeholder = composeMode === "send" ? `Message ${name}` : `Ask Inbox Manager about ${name}`;
  $("#chat-hint").textContent = composeMode === "send" ? `Sends as you on Telegram · ${SEND_HINT}` : "Opens a thread with Inbox Manager · nothing is sent";
  $("button.send", form).title = composeMode === "send" ? "Send (Enter)" : "Ask (Enter)";
  const chip = $("#reply-chip");
  chip.hidden = !replyTo || composeMode !== "send";
  if (replyTo) {
    chip.innerHTML = `<span class="rc-text">↩ Replying to <b>${esc(replyTo.out ? "yourself" : replyTo.sender.name)}</b>: ${esc((replyTo.text || replyTo.media || "").slice(0, 120))}</span>
      <button type="button" class="icon-btn" id="reply-cancel" title="Cancel reply (Esc)">✕</button>`;
  }
}
function setReply(m) {
  replyTo = m;
  composeMode = "send";
  updateComposer();
  $("#chat-input").focus();
}
$("#compose-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  composeMode = b.dataset.mode;
  updateComposer();
  $("#chat-input").focus();
});
$("#reply-chip").addEventListener("click", (e) => {
  if (e.target.closest("#reply-cancel")) { replyTo = null; updateComposer(); }
});

wireComposer($("#chat-composer"), $("#chat-input"), async (v) => {
  const chatId = currentChat;
  const c = chatById(chatId);
  if (composeMode === "ask") {
    askInPane(`[About "${c?.name}" · chat_id ${chatId}] ${v}`, c?.name);
    return;
  }
  const rt = replyTo;
  replyTo = null;
  updateComposer();
  const form = $("#chat-composer");
  const restore = () => {
    if (currentChat !== chatId) return;
    setInput(form, $("#chat-input"), v);
    if (rt) { replyTo = rt; updateComposer(); }
  };
  try {
    const msg = await sendMessage(form, chatId, v, rt?.id);
    if (!msg) return restore();
    lastSent = { chatId, msgId: msg.id, at: Date.now() };
    if (currentChat === chatId && view === "chat") {
      if (chatMeta.hasNewer) return navigate({ view: "chat", chatId });  // was viewing older history
      const feed = $("#chat-feed");
      $(".empty", feed)?.remove();
      const prev = chatMessages[chatMessages.length - 1];
      chatMessages.push(msg);
      feed.insertAdjacentHTML("beforeend", chatRow(msg, prev, "just-sent"));
      feed.scrollTop = feed.scrollHeight;
    } else {
      toast(`✓ Sent to <b>${esc(c?.name || "chat")}</b>`);
    }
  } catch (err) {
    restore();
    toast(`Not sent: ${esc(err.message)}`, true, 7000);
  }
}, () => composeMode === "ask" && busy);

// ================================================================== Activity: mentions & replies (Slack-style)
// Everything lives in the server's Activity database, so nothing ever disappears. A mention
// counts as read once it has been on screen for a moment (or you open it), and the badge
// comes from the same place as the list.
let mentionFilter = "all";
let mentionData = null;  // {items, has_more, unread}

async function loadMentions(refresh = false) {
  const feed = $("#mention-feed");
  if (!mentionData || refresh) feed.innerHTML = `<div class="loading">${refresh ? "Re-checking Telegram…" : "Loading…"}</div>`;
  try {
    mentionData = await api(`/api/mentions?filter=${mentionFilter}&limit=100${refresh ? "&refresh=true" : ""}`);
  } catch (e) {
    feed.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
    return;
  }
  renderMentions();
  setBadges(mentionData.unread);
}
async function loadOlderMentions() {
  const last = mentionData?.items[mentionData.items.length - 1];
  if (!last) return;
  const more = await api(`/api/mentions?filter=${mentionFilter}&limit=100&before=${last.ts}`);
  mentionData.items.push(...more.items);
  mentionData.has_more = more.has_more;
  renderMentions();
}
function updateMentionBadge(unread) {
  if (unread != null && mentionData) mentionData.unread = unread;
  setBadges(mentionData ? mentionData.unread : state?.mentions_unread || 0);
}
function visibleMentions() { return mentionData?.items || []; }

function renderMentions() {
  const items = visibleMentions();
  const feed = $("#mention-feed");
  const unreadNote = mentionData.unread ? `<div class="act-summary"><a href="#" data-show-unread>${mentionData.unread} unread</a> · <a href="#" data-read-all>Mark all as read</a></div>` : "";
  if (!items.length) {
    feed.innerHTML = `<div class="empty"><div class="big">${mentionFilter === "unread" ? "🎉" : "💬"}</div>${mentionFilter === "unread" ? "You're all caught up." : "No mentions yet."}</div>`;
    return;
  }
  let day = null;
  feed.innerHTML = unreadNote + items.map((m) => {
    const label = dayLabel(m.date);
    const head = label !== day ? dayPill(label) : "";
    day = label;
    return head + mentionRow(m);
  }).join("") + (mentionData.has_more ? `<button class="load-older" data-load-older>Load older mentions</button>` : "");
  watchUnreadMentions();
}

function mentionRow(m) {
  const verb = m.kind === "reply" ? "replied to you" : "mentioned you";
  const quote = m.replying_to ? `<div class="quote"><b>You:</b> ${tgText(m.replying_to.slice(0, 300))}</div>` : "";
  const actions = `${state.sending_enabled ? `<button data-act="reply" title="Reply in Telegram">↩ Reply</button>` : ""}
    <button data-act="context" title="Show the messages around it here">☰ Context</button>
    <button data-act="ask" title="Ask Inbox Manager">✦ Ask</button>
    ${m.link ? `<a class="ext" href="${esc(m.link)}" target="_blank" rel="noopener">↗ Telegram</a>` : ""}
    <button data-act="toggle-read">${m.unread ? "Mark as read" : "Mark unread"}</button>`;
  const tag = `<span class="tag ${m.kind}">${m.kind === "reply" ? "REPLY" : "MENTION"}</span>`;
  return `<div class="act ${m.unread ? "unread" : ""}" data-key="${esc(m.key)}" title="Open in ${esc(m.chat.name)}">
    <div class="line1">${m.unread ? `<span class="dot"></span>` : ""}<span><b>${esc(m.sender.name)}</b> ${verb} in <b>${m.topic ? `# ${esc(m.topic)}</b> · <b>${esc(m.chat.name)}` : esc(chatLabel(m.chat))}</b></span><span class="sp"></span><span>${esc(m.date.slice(11))}</span></div>
    ${msgRow(m, null, { actions, tag, after: quote })}
    <div class="reply-slot"></div><div class="ctx-slot"></div></div>`;
}

// Read on view, like Slack: an unread mention that stays on screen for ~1s (while the window has
// focus) becomes read; the server also clears Telegram's @ mark on that one message.
const seenQueue = new Set();
let seenTimer = null;
const seenIO = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const en of entries) {
    const row = en.target;
    clearTimeout(row._seen);
    if (en.isIntersecting && en.intersectionRatio >= 0.6) {
      row._seen = setTimeout(() => { if (document.hasFocus() && view === "mentions") queueSeen(row.dataset.key); }, 1000);
    }
  }
}, { threshold: [0, 0.6] }) : null;
function watchUnreadMentions() {
  seenIO?.disconnect();
  for (const row of $$("#mention-feed .act.unread")) seenIO?.observe(row);
}
function queueSeen(key) {
  seenQueue.add(key);
  clearTimeout(seenTimer);
  seenTimer = setTimeout(flushSeen, 400);
}
async function flushSeen() {
  const keys = [...seenQueue];
  seenQueue.clear();
  if (keys.length) await setMentionsRead(keys, true);
}
async function setMentionsRead(keys, read) {
  let res;
  try { res = await postJson("/api/mentions/read", { keys, read }); } catch (e) { return toast(`Couldn't update: ${esc(e.message)}`, true); }
  for (const m of mentionData?.items || []) {
    if (!keys.includes(m.key)) continue;
    m.unread = !read;
    const row = $(`#mention-feed .act[data-key="${CSS.escape(m.key)}"]`);
    if (row) {
      row.classList.toggle("unread", !read);
      row.querySelector(".line1 .dot")?.remove();
      if (!read) row.querySelector(".line1").insertAdjacentHTML("afterbegin", `<span class="dot"></span>`);
      const b = row.querySelector('[data-act="toggle-read"]');
      if (b) b.textContent = read ? "Mark unread" : "Mark as read";
    }
  }
  updateMentionBadge(res.unread);
  const note = $("#mention-feed .act-summary");
  if (note && !res.unread) note.remove();
  else if (note) note.querySelector("[data-show-unread]").textContent = `${res.unread} unread`;
}
async function markAllMentionsRead() {
  let res;
  try { res = await api("/api/mentions/read-all", { method: "POST" }); } catch (e) { return toast(`Couldn't update: ${esc(e.message)}`, true); }
  for (const m of mentionData?.items || []) m.unread = false;
  updateMentionBadge(0);
  renderMentions();
  toast(`✓ Marked ${res.count} mention${res.count === 1 ? "" : "s"} as read`);
}
const markAllDone = markAllMentionsRead;  // the header button's old name

function contextHtml(c) {
  const parent = c.replying_to && !c.before.some((m) => m.id === c.replying_to.id)
    ? `<div class="sep">Replying to</div>${msgRow(c.replying_to)}<div class="sep">…</div>` : "";
  let prev = null;
  const rows = [...c.before, c.message, ...c.after].map((m) => {
    const html = msgRow(m, prev, { cls: m.id === c.message.id ? "target" : "" });
    prev = m.id === c.message.id ? null : m;
    return html;
  }).join("");
  return `<div class="context">${parent}${rows}</div>`;
}
async function toggleContext(row, chatId, msgId) {
  const slot = $(".ctx-slot", row);
  if (slot.innerHTML) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="context"><div class="sep">Loading…</div></div>`;
  try {
    slot.innerHTML = contextHtml(await api(`/api/context/${chatId}/${msgId}`));
  } catch (err) {
    slot.innerHTML = `<div class="context"><div class="sep err">${esc(err.message)}</div></div>`;
  }
}

function openInlineReply(row, m) {
  const slot = $(".reply-slot", row);
  if (slot.innerHTML) { $("textarea", slot)?.focus(); return; }
  const [chatId, msgId] = m.key.split(":").map(Number);
  slot.innerHTML = `<div class="inline-reply"><form class="composer">
      <textarea rows="1" placeholder="Reply to ${esc(m.sender.name)} in ${esc(m.chat.name)}"></textarea>
      <div class="composer-bar"><span class="hint">Replies to this message on Telegram · ${SEND_HINT} · Esc to cancel</span>
      <button type="button" class="cancel">Cancel</button><button type="submit" class="send" title="Send (Enter)">➤</button></div>
    </form></div>`;
  const form = $("form", slot);
  const input = $("textarea", slot);
  const close = () => { slot.innerHTML = ""; };
  $(".cancel", slot).addEventListener("click", close);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  wireComposer(form, input, async (v) => {
    try {
      const msg = await sendMessage(form, chatId, v, msgId);
      if (!msg) return setInput(form, input, v);
      slot.innerHTML = `<div class="replied">✓ You replied: ${esc(v.slice(0, 140))} · <a href="#" data-open-sent="${msg.id}">View in chat</a></div>`;
      if (m.unread) await setMentionsRead([m.key], true);  // answered: it's read
    } catch (err) {
      setInput(form, input, v);
      toast(`Not sent: ${esc(err.message)}`, true, 7000);
    }
  });
  input.focus();
}

$("#mention-feed").addEventListener("click", async (e) => {
  if (e.target.closest("[data-load-older]")) return loadOlderMentions();
  if (e.target.closest("[data-read-all]")) { e.preventDefault(); return markAllMentionsRead(); }
  if (e.target.closest("[data-show-unread]")) { e.preventDefault(); return $('#mention-tabs [data-f="unread"]').click(); }
  const row = e.target.closest(".act");
  if (!row || e.target.closest(".context") || e.target.closest(".att")) return;
  const m = mentionData.items.find((x) => x.key === row.dataset.key);
  const [chatId, msgId] = m.key.split(":").map(Number);
  const sent = e.target.closest("[data-open-sent]");
  if (sent) { e.preventDefault(); return navigate({ view: "chat", chatId, focus: Number(sent.dataset.openSent) }); }
  if (e.target.closest("a") || e.target.closest(".reply-slot")) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "reply") openInlineReply(row, m);
  else if (act === "context") toggleContext(row, chatId, msgId);
  else if (act === "toggle-read") {
    await setMentionsRead([m.key], m.unread);
  } else if (act === "ask") {
    askInPane(`What does ${m.sender.name} want from me here, and what should I do? (mention key ${m.key} in "${m.chat.name}")`, m.chat.name);
  } else {
    if (m.unread) setMentionsRead([m.key], true);
    navigate({ view: "chat", chatId, focus: msgId, topic: m.topic_id || undefined });  // jump to it in its chat (and topic)
  }
});

$("#mention-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  mentionFilter = b.dataset.f;
  $$("#mention-tabs button").forEach((x) => x.classList.toggle("on", x === b));
  loadMentions();
});

// ================================================================== search: dropdown, results (messages / channels / people)
let searchScope = null;  // chat id when searching inside one conversation (Cmd+F)
let popItems = [];
let popSel = 0;
let lastSearch = { q: "", scope: null, items: [], tab: "messages" };

function setScope(chatId) {
  searchScope = chatId;
  const el = $("#search-scope");
  const c = chatId && chatById(chatId);
  el.hidden = !c;
  if (c) el.innerHTML = `in ${esc(chatLabel(c))} <button type="button" title="Search everywhere">✕</button>`;
  $("#search").placeholder = c ? "Search this conversation" : "Search Telegram";
}
$("#search-scope").addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) { e.preventDefault(); setScope(null); renderPop(); }
});

function focusSearch(inChat = false) {
  setScope(inChat && view === "chat" ? currentChat : null);
  const s = $("#search");
  s.focus();
  s.select();
  renderPop();
}

function renderPop() {
  const q = $("#search").value.trim();
  const pop = $("#search-pop");
  if (document.activeElement !== $("#search")) { pop.hidden = true; return; }
  popItems = [];
  let html = "";
  if (q) {
    popItems.push({ type: "messages" });
    html += `<div class="pop-head">Messages</div><div class="pop-item" data-i="0"><span class="ico">⌕</span><span class="nm">Search messages for “<b>${esc(q)}</b>”${searchScope ? ` in ${esc(chatById(searchScope)?.name || "")}` : ""}</span><span class="sub">↵</span></div>`;
  }
  if (!searchScope) {
    const chats = q ? matchChats(q, () => true, 8) : recentChats().slice(0, 6);
    if (chats.length) {
      html += `<div class="pop-head">${q ? "Channels & people" : "Recent"}</div>`;
      for (const c of chats) {
        const i = popItems.push({ type: "chat", chat: c }) - 1;
        const icon = c.kind === "dm" || c.kind === "bot" ? chatAv(c, "s24") : `<span class="ico">${chatGlyph(c)}</span>`;
        html += `<div class="pop-item" data-i="${i}">${icon}<span class="nm">${esc(c.name)}</span><span class="sub">${c.unread_count ? `${c.unread_count} unread · ` : ""}${esc(ago(c.last_ts))}</span></div>`;
      }
    }
  }
  if (!html) { pop.hidden = true; return; }
  popSel = Math.min(popSel, popItems.length - 1);
  pop.innerHTML = html;
  pop.hidden = false;
  highlightPop();
}
function highlightPop() {
  $$("#search-pop .pop-item").forEach((el) => el.classList.toggle("sel", Number(el.dataset.i) === popSel));
  $("#search-pop .pop-item.sel")?.scrollIntoView({ block: "nearest" });
}
function choosePop(i) {
  const item = popItems[i];
  const q = $("#search").value.trim();
  if (!item) return;
  $("#search").blur();
  $("#search-pop").hidden = true;
  if (item.type === "chat") { $("#search").value = ""; navigate({ view: "chat", chatId: item.chat.id }); }
  else if (q) navigate({ view: "search", q, scope: searchScope || undefined });
}
$("#search").addEventListener("input", () => { popSel = 0; renderPop(); });
$("#search").addEventListener("focus", renderPop);
$("#search").addEventListener("blur", () => setTimeout(() => { $("#search-pop").hidden = true; }, 150));
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); popSel = Math.min(popSel + 1, popItems.length - 1); highlightPop(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); popSel = Math.max(popSel - 1, 0); highlightPop(); }
  else if (e.key === "Escape") { e.stopPropagation(); $("#search").blur(); }
  else if (e.key === "Backspace" && !$("#search").value && searchScope) { setScope(null); renderPop(); }
});
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); choosePop(popSel); });
$("#search-pop").addEventListener("mousedown", (e) => {
  const it = e.target.closest(".pop-item");
  if (it) { e.preventDefault(); choosePop(Number(it.dataset.i)); }
});

async function runSearch(q, scope) {
  setView("search");
  const c = scope && chatById(scope);
  header(`<span class="hash">⌕</span><h1>Results for “${esc(q)}”</h1>${c ? `<span class="topic">in ${esc(chatLabel(c))}</span>` : ""}`,
    `<button class="btn" data-act="ask-search">✦ <span class="lbl">Ask about this</span></button>`);
  $("#search").value = q;
  const channels = scope ? [] : matchChats(q, (x) => x.kind !== "dm" && x.kind !== "bot", 100);
  const people = scope ? [] : matchChats(q, (x) => x.kind === "dm" || x.kind === "bot", 100);
  lastSearch = { q, scope, items: null, channels, people, tab: "messages" };
  $("#st-ch").textContent = channels.length;
  $("#st-pp").textContent = people.length;
  $("#st-msg").textContent = "";
  $$("#search-tabs button").forEach((b) => { b.classList.toggle("on", b.dataset.t === "messages"); b.hidden = !!scope && b.dataset.t !== "messages"; });
  $("#search-feed").innerHTML = `<div class="loading">Searching Telegram…</div>`;
  try {
    const items = (await api(`/api/search?q=${encodeURIComponent(q)}${scope ? `&chat=${scope}` : ""}`)).items;
    if (lastSearch.q !== q) return;
    lastSearch.items = items;
    $("#st-msg").textContent = items.length;
  } catch (err) {
    lastSearch.items = [];
    $("#search-feed").innerHTML = `<div class="empty err">${esc(err.message)}</div>`;
    return;
  }
  // If nothing matches as text but a group name does, show the group tab first.
  if (!lastSearch.items.length && (channels.length || people.length)) lastSearch.tab = channels.length ? "channels" : "people";
  renderSearch();
}

function renderSearch() {
  const { q, tab } = lastSearch;
  $$("#search-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
  const feed = $("#search-feed");
  if (tab === "messages") {
    const items = lastSearch.items || [];
    if (!items.length) { feed.innerHTML = `<div class="empty">No messages match “${esc(q)}”.</div>`; return; }
    feed.innerHTML = items.map((m, i) => `<div class="act" data-i="${i}" title="Open in its chat">
      <div class="line1"><b>${esc(m.chat.kind === "dm" ? m.chat.name : "# " + m.chat.name)}</b><span class="sp"></span><span>${esc(dayLabel(m.date))} ${esc(m.date.slice(11))}</span></div>
      ${msgRow(m, null, { highlight: q, actions: `<button data-act="context">☰ Context</button>${m.link ? `<a class="ext" href="${esc(m.link)}" target="_blank" rel="noopener">↗ Telegram</a>` : ""}` })}
      <div class="ctx-slot"></div></div>`).join("");
  } else {
    const list = tab === "channels" ? lastSearch.channels : lastSearch.people;
    if (!list.length) { feed.innerHTML = `<div class="empty">No ${tab} match “${esc(q)}”.</div>`; return; }
    feed.innerHTML = list.map((c) => `<div class="ch-row" data-chat="${c.id}">
      ${c.kind === "dm" || c.kind === "bot" ? chatAv(c, "") : `<span class="ico">${chatGlyph(c)}</span>`}
      <div class="grow"><div class="nm">${esc(c.name)}${c.username ? ` <span class="sub">@${esc(c.username)}</span>` : ""}</div>
      <div class="sub">${esc(c.kind === "dm" ? "Direct message" : c.kind)}${c.muted ? " · muted" : ""}${c.unread_count ? ` · ${c.unread_count} unread` : ""} · last active ${esc(ago(c.last_ts))}</div></div>
      </div>`).join("");
  }
}
$("#search-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (!b || !lastSearch.items) return;
  lastSearch.tab = b.dataset.t;
  renderSearch();
});
$("#search-feed").addEventListener("click", (e) => {
  const chRow = e.target.closest(".ch-row");
  if (chRow) return navigate({ view: "chat", chatId: Number(chRow.dataset.chat) });
  const row = e.target.closest(".act");
  if (!row || e.target.closest("a") || e.target.closest(".context") || e.target.closest(".att")) return;
  const m = lastSearch.items[Number(row.dataset.i)];
  if (e.target.closest('[data-act="context"]')) return toggleContext(row, m.chat.id, m.id);
  navigate({ view: "chat", chatId: m.chat.id, focus: m.id, topic: m.topic_id || undefined });  // jump to it in its chat (and topic)
});

// ================================================================== quick switcher (Cmd+K)
let swMode = "all";
let swItems = [];
let swSel = 0;
function remember(chatId) {
  const r = (store("recentChats") || []).filter((x) => x !== chatId);
  r.unshift(chatId);
  store("recentChats", r.slice(0, 20));
}
function recentChats() {
  const ids = store("recentChats") || [];
  const recent = ids.map((id) => chatById(id)).filter(Boolean);
  const unread = (state?.chats || []).filter((c) => c.unread_count && c.tier === "must" && !ids.includes(c.id));
  return [...recent, ...unread];
}
function openSwitcher(mode = "all") {
  swMode = mode;
  $("#switcher").hidden = false;
  const input = $("#switcher-input");
  input.value = "";
  input.placeholder = { dms: "Jump to a direct message…", channels: "Jump to a channel…", people: "Find a person…",
    compose: "New message to… (a person or a channel)", forward: "Forward to… (a person or a channel)" }[mode] || "Jump to…";
  swSel = 0;
  renderSwitcher();
  input.focus();
}
function closeSwitcher() { $("#switcher").hidden = true; }
function renderSwitcher() {
  const q = $("#switcher-input").value.trim();
  const filter = swMode === "dms" ? (c) => c.kind === "dm" || c.kind === "bot"
    : swMode === "people" ? (c) => c.kind === "dm"
    : swMode === "channels" ? (c) => c.kind !== "dm" && c.kind !== "bot"
    : swMode === "compose" || swMode === "forward" ? (c) => c.kind !== "channel" || c.id === state?.me.peer : () => true;
  const specials = swMode === "all" ? [
    { type: "view", view: "manager", name: "Inbox Manager", icon: "✦" },
    { type: "view", view: "mentions", name: "Mentions & replies", icon: "@" },
  ].filter((s) => !q || score(s.name, q) > 0) : [];
  const chats = q ? matchChats(q, filter, 40) : (recentChats().filter(filter).slice(0, 12).length ? recentChats().filter(filter).slice(0, 12) : allChats.filter(filter).slice(0, 12));
  const topicItems = q && swMode === "all" ? Object.entries(state?.topics || {}).flatMap(([cid, ts]) => {
    const c = chatById(Number(cid));
    return c ? ts.filter((t) => score(`${t.title} ${c.name}`, q) > 0).map((t) => ({ type: "topic", chat: c, topic: t, s: score(t.title, q) })) : [];
  }).sort((a, b) => b.s - a.s).slice(0, 12) : [];
  swItems = [...specials, ...chats.map((c) => ({ type: "chat", chat: c })), ...topicItems];
  swSel = Math.min(swSel, Math.max(swItems.length - 1, 0));
  const list = $("#switcher-list");
  if (!swItems.length) { list.innerHTML = `<div class="empty" style="padding:24px">No conversation matches “${esc(q)}”.</div>`; return; }
  list.innerHTML = (q ? "" : `<div class="pop-head">Recent</div>`) + swItems.map((it, i) => {
    if (it.type === "view") return `<div class="pop-item" data-i="${i}"><span class="ico">${it.icon}</span><span class="nm">${esc(it.name)}</span></div>`;
    if (it.type === "topic") return `<div class="pop-item" data-i="${i}"><span class="ico">#</span><span class="nm">${esc(it.topic.title)} <span class="sub">· ${esc(it.chat.name)}</span></span>
      <span class="sub">${it.topic.unread_count ? `<b class="pill">${it.topic.unread_count > 99 ? "99+" : it.topic.unread_count}</b> ` : ""}${esc(ago(it.topic.last_ts))}</span></div>`;
    const c = it.chat;
    const icon = c.kind === "dm" || c.kind === "bot" ? chatAv(c, "s24") : `<span class="ico">${chatGlyph(c)}</span>`;
    return `<div class="pop-item" data-i="${i}">${icon}<span class="nm">${esc(c.name)}</span>
      <span class="sub">${c.unread_count ? `<b class="pill">${c.unread_count > 99 ? "99+" : c.unread_count}</b> ` : ""}${c.muted ? "muted · " : ""}${esc(ago(c.last_ts))}</span></div>`;
  }).join("");
  $$("#switcher-list .pop-item").forEach((el) => el.classList.toggle("sel", Number(el.dataset.i) === swSel));
  $("#switcher-list .pop-item.sel")?.scrollIntoView({ block: "nearest" });
}
function chooseSwitcher(i) {
  const it = swItems[i];
  if (!it) return;
  closeSwitcher();
  if (swMode === "forward") return it.type === "chat" && finishForward(it.chat);
  navigate(it.type === "view" ? { view: it.view } : { view: "chat", chatId: it.chat.id, topic: it.type === "topic" ? it.topic.id : undefined });
  if (swMode === "compose" && it.type === "chat") {  // ⌘N: land in the message box, ready to type
    composeMode = state.sending_enabled ? "send" : "ask";
    updateComposer();
    setTimeout(() => $("#chat-input").focus(), 60);
  }
}
$("#switcher-input").addEventListener("input", () => { swSel = 0; renderSwitcher(); });
$("#switcher-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); swSel = Math.min(swSel + 1, swItems.length - 1); renderSwitcher(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); swSel = Math.max(swSel - 1, 0); renderSwitcher(); }
  else if (e.key === "Enter") { e.preventDefault(); chooseSwitcher(swSel); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSwitcher(); }
});
$("#switcher-list").addEventListener("mousedown", (e) => {
  const it = e.target.closest(".pop-item");
  if (it) { e.preventDefault(); chooseSwitcher(Number(it.dataset.i)); }
});
$("#switcher").addEventListener("mousedown", (e) => { if (e.target.id === "switcher") closeSwitcher(); });

// ================================================================== keyboard shortcuts (Slack's official set, rebindable)
// Mirrors slack.com/help/articles/201374536 (Mac), group by group. def = Slack's key.
// alt = extra keys, mostly where a browser keeps Slack's key for itself (⌘T, ⌘N, ⌘⇧T, ⌘⇧A).
// when: "any" fires anywhere, "composer" while typing in a message box, "page" when not typing,
// "message" when a message is selected with ↑/↓ in a message list (press F6 to get there).
const ACTIONS = [
  // Slack basics
  ["Slack basics", "compose", "Compose a new message", "Mod+N", ["Mod+Alt+N"], "any", () => openSwitcher("compose")],
  ["Slack basics", "unsend", "Unsend a message (in an empty box, right after sending) · undo formatting while typing", "Mod+Z", [], "composer", (t) => unsendOrUndo(t)],
  ["Slack basics", "status", "Set your status (your Telegram bio)", "Mod+Shift+Y", [], "any", () => openStatus()],
  ["Slack basics", "prefs", "Open your preferences", "Mod+,", [], "any", () => openShortcuts()],
  ["Slack basics", "toggleRight", "Hide the right sidebar (thread pane)", "Mod+.", [], "any", togglePane],
  ["Slack basics", "canvas", "Create a new canvas (a note in Saved Messages)", "Mod+Shift+N", [], "any", () => newCanvas()],
  ["Slack basics", "upload", "Upload a file", "Mod+O", [], "any", () => uploadFile()],
  ["Slack basics", "downloads", "View all downloaded files", "Mod+Shift+J", [], "any", () => openFiles()],
  ["Slack basics", "snippet", "Create a new snippet (turn the message into a code block)", "Mod+Shift+Enter", [], "composer", (t) => makeSnippet(t)],
  ["Slack basics", "reactLast", "Add an emoji reaction to a message (the latest one; same key as ⌘⇧` ⌘⇧# ⌘⇧_ on other layouts)", "Mod+Shift+\\", [], "any", () => reactToLast()],
  ["Slack basics", "search", "Start a search", "Mod+G", [], "any", () => focusSearch(false)],
  ["Slack basics", "searchInChat", "Search in the current conversation", "Mod+F", [], "any", () => focusSearch(true)],
  ["Slack basics", "huddle", "Start, join, leave, or end a huddle (opens the voice chat in Telegram)", "Mod+Shift+H", [], "any", () => startHuddle()],
  ["Slack basics", "help", "Open Help", "F1", [], "any", () => openShortcuts()],
  ["Slack basics", "fullScreen", "Toggle full screen view", "Mod+Ctrl+F", [], "any", toggleFullScreen],
  ["Slack basics", "people", "Open the People view", "Mod+Shift+E", [], "any", () => openSwitcher("people")],
  ["Slack basics", "quickSwitcher", "Jump to a conversation", "Mod+K", ["Mod+T"], "any", () => ($("#switcher").hidden ? openSwitcher() : closeSwitcher())],
  // Navigate conversations and messages
  ["Navigate conversations and messages", "jumpUnread", "Jump to the most recent unread message in a conversation", "Mod+J", [], "any", jumpToUnread],
  ["Navigate conversations and messages", "prevUnread", "Jump to previous unread channel or DM", "Alt+Shift+ArrowUp", [], "any", () => stepChat(-1, true)],
  ["Navigate conversations and messages", "nextUnread", "Jump to next unread channel or DM", "Alt+Shift+ArrowDown", [], "any", () => stepChat(1, true)],
  ["Navigate conversations and messages", "prevChat", "Jump to previous channel or DM in the sidebar", "Alt+ArrowUp", [], "any", () => stepChat(-1, false)],
  ["Navigate conversations and messages", "nextChat", "Jump to next channel or DM in the sidebar", "Alt+ArrowDown", [], "any", () => stepChat(1, false)],
  ["Navigate conversations and messages", "back", "Go back in history", "Mod+[", [], "any", goBack],
  ["Navigate conversations and messages", "forward", "Go forward in history", "Mod+]", [], "any", goForward],
  ["Navigate conversations and messages", "home", "Open the Home view", "Ctrl+1", [], "any", openHome],
  ["Navigate conversations and messages", "browseDMs", "Browse DMs", "Mod+Shift+K", [], "any", () => openSwitcher("dms")],
  ["Navigate conversations and messages", "more", "Open the More view", "Ctrl+0", [], "any", () => openMore()],
  ["Navigate conversations and messages", "activity", "Open the Activity view (Mentions & replies)", "Mod+Shift+M", [], "any", () => navigate({ view: "mentions" })],
  ["Navigate conversations and messages", "threads", "Open the Threads view (Inbox Manager)", "Mod+Shift+T", ["Mod+Alt+T"], "any", () => navigate({ view: "manager" })],
  ["Navigate conversations and messages", "browseChannels", "Browse channels", "Mod+Shift+L", [], "any", () => openSwitcher("channels")],
  ["Navigate conversations and messages", "details", "Open conversation details", "Mod+Shift+I", [], "any", () => view === "chat" && openDetails(currentChat)],
  ["Navigate conversations and messages", "nextSection", "Move focus to the next section", "F6", [], "any", () => cycleFocus(1)],
  ["Navigate conversations and messages", "prevSection", "Move focus to the previous section", "Shift+F6", [], "any", () => cycleFocus(-1)],
  // Mark messages read or unread
  ["Mark messages read or unread", "markRead", "Mark all messages in current conversation as read", "Escape", [], "page", escRead],
  ["Mark messages read or unread", "markAllRead", "Mark all messages as read", "Shift+Escape", [], "any", markAllRead],
  // Navigate unread messages
  ["Navigate unread messages", "allUnreads", "Open the All unreads view", "Mod+Shift+A", ["Mod+Alt+A"], "any", () => navigate({ view: "unreads" })],
  // Switch workspaces (Telegram chat folders)
  ["Switch workspaces (Telegram folders)", "workspaceSwitcher", "Expand or collapse the workspace (folder) switcher", "Mod+Shift+S", [], "any", () => toggleFolderSwitcher()],
  ["Switch workspaces (Telegram folders)", "prevWorkspace", "Switch to previous workspace (folder)", "Ctrl+Shift+Tab", ["Mod+Alt+["], "any", () => stepFolder(-1)],
  ["Switch workspaces (Telegram folders)", "nextWorkspace", "Switch to next workspace (folder)", "Ctrl+Tab", ["Mod+Alt+]"], "any", () => stepFolder(1)],
  // Switch tabs
  ["Switch tabs", "prevTab", "Switch to the previous tab", "Ctrl+PageUp", [], "any", () => switchTab(-1)],
  ["Switch tabs", "nextTab", "Switch to the next tab", "Ctrl+PageDown", [], "any", () => switchTab(1)],
  // Take actions on messages
  ["Take actions on messages", "edit", "Edit a message you sent", "E", [], "message", () => editMessage()],
  ["Take actions on messages", "delete", "Delete a message you sent", "Delete", ["Backspace"], "message", () => deleteMessage()],
  ["Take actions on messages", "reply", "Open or reply to a thread (reply to the message)", "T", ["ArrowRight"], "message", (m) => replyToSelected(m)],
  ["Take actions on messages", "forward", "Forward a message", "F", [], "message", () => forwardMessage()],
  ["Take actions on messages", "pin", "Pin or unpin a message", "P", [], "message", () => togglePin()],
  ["Take actions on messages", "save", "Save a message (to Saved Messages)", "A", [], "message", (m) => saveSelected(m)],
  ["Take actions on messages", "markAboveUnread", "Mark all messages above the one in focus as unread (the whole chat, in Telegram)", "U", [], "message", () => markUnread(currentChat)],
  ["Take actions on messages", "remind", "Create a reminder about a message", "M", [], "message", () => remindMe()],
  ["Take actions on messages", "react", "Add an emoji reaction to a message", "R", [], "message", () => reactPicker()],
  // Format messages
  ["Format messages", "selLineStart", "Select text to beginning of current line", "Shift+ArrowUp", [], "composer", (t) => selectToLine(t, -1)],
  ["Format messages", "selLineEnd", "Select text to end of current line", "Shift+ArrowDown", [], "composer", (t) => selectToLine(t, 1)],
  ["Format messages", "bold", "Bold selected text", "Mod+B", [], "composer", (t) => wrapSel(t, "**")],
  ["Format messages", "italic", "Italicize selected text", "Mod+I", [], "composer", (t) => wrapSel(t, "__")],
  ["Format messages", "underline", "Underline selected text", "Mod+U", [], "composer", (t) => wrapSel(t, "++")],
  ["Format messages", "strike", "Strikethrough selected text", "Mod+Shift+X", [], "composer", (t) => wrapSel(t, "~~")],
  ["Format messages", "link", "Hyperlink selected text", "Mod+Shift+U", [], "composer", addLink],
  ["Format messages", "quote", "Quote selected text", "Mod+Shift+9", [], "composer", (t) => prefixLines(t, () => "> ")],
  ["Format messages", "code", "Code selected text", "Mod+Shift+C", [], "composer", (t) => wrapSel(t, "`")],
  ["Format messages", "codeBlock", "Codeblock selected text", "Mod+Alt+Shift+C", [], "composer", (t) => wrapSel(t, "```\n", "\n```")],
  ["Format messages", "bulleted", "Format selected text as a bulleted list", "Mod+Shift+8", [], "composer", (t) => prefixLines(t, () => "• ")],
  ["Format messages", "numbered", "Format selected text as a numbered list", "Mod+Shift+7", [], "composer", (t) => prefixLines(t, (i) => `${i + 1}. `)],
  ["Format messages", "applyMarkdown", "Apply markdown formatting (Slack *bold* _italic_ ~strike~ → Telegram)", "Mod+Shift+F", [], "composer", applyMarkdown],
  // Not in Slack
  ["This app (not in Slack)", "later", "Open Saved Messages", "Mod+Alt+L", [], "any", openSaved],
  ["This app (not in Slack)", "jumpLatest", "Jump to the newest messages", "Mod+Alt+J", [], "any", () => view === "chat" && navigate({ view: "chat", chatId: currentChat })],
  ["This app (not in Slack)", "summarize", "Ask the manager to summarize this conversation", "Mod+Alt+S", [], "any", summarizeChat],
  ["This app (not in Slack)", "refresh", "Re-scan Telegram", "Mod+Alt+R", [], "any", () => $("#refresh").click()],
  ["This app (not in Slack)", "focusComposer", "Focus the message field", "", [], "any", focusComposer],
].map(([group, id, label, def, alt, when, run]) => ({ group, id, label, def, alt, when, run }));

// Official Slack shortcuts that work here but aren't single rebindable keys (mouse, or context keys).
const FIXED = [
  ["Slack basics", "Create a new line", "Shift+Enter"],
  ["Slack basics", "Resize the left sidebar (press F6 to focus the sidebar first)", "ArrowLeft / ArrowRight"],
  ["Navigate conversations and messages", "Expand or collapse all sidebar sections", "Alt+Click a section"],
  ["Mark messages read or unread", "Mark a message as unread (Telegram marks the whole chat)", "Alt+Click a message"],
  ["Navigate unread messages", "Move between messages", "ArrowUp / ArrowDown"],
  ["Navigate unread messages", "Mark a group of messages as read", "Escape"],
  ["Navigate unread messages", "Open or collapse a group of messages", "ArrowLeft / ArrowRight"],
  ["Switch tabs", "Switch to a specific tab (Ctrl+1 is Home)", "Ctrl+2…9"],
  ["Switch workspaces (Telegram folders)", "Switch to a specific workspace (folder); browsers keep ⌘1…9, so ⌘⌥1…9 works too", "Mod+1…9 / Mod+Alt+1…9"],
  ["Format messages", "Undo formatting (same key as Unsend)", "Mod+Z"],
];
// Official Slack shortcuts with no equivalent for a Telegram account in a browser.
const NOT_AVAILABLE = [
  ["Toggle mute on a huddle", "Mod+Shift+Space", "the voice chat runs in Telegram, not in this page"],
  ["Close window", "Mod+W", "browsers never pass this key to a page"],
  ["Reopen last closed window", "Mod+Shift+W", "browsers never pass this key to a page"],
  ["Quit Slack", "Mod+Q", "browsers never pass this key to a page"],
  ["Canvas formatting and navigation (12 more, outside the 77)", "Mod+Alt+1", "Telegram has no canvases; ⌘⇧N makes a note instead"],
];
let overrides = {};
const action = (id) => ACTIONS.find((a) => a.id === id);
// The keys that trigger an action: the user's single choice, or Slack's default plus alternates.
const bindingsOf = (a) => (a.id in overrides ? [overrides[a.id]] : [a.def, ...a.alt]).filter(Boolean);
const bindingOf = (a) => bindingsOf(a)[0] || "";

const CODE_KEYS = { BracketLeft: "[", BracketRight: "]", Period: ".", Comma: ",", Slash: "/", Backslash: "\\", Semicolon: ";",
  Quote: "'", Minus: "-", Equal: "=", Backquote: "`", Space: "Space" };
function comboFromEvent(e) {
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (["Meta", "Control", "Alt", "Shift", "OS"].includes(key)) return null;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const parts = [];
  if (mod) parts.push("Mod");
  if (IS_MAC && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}
const KEY_GLYPH = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Enter: "↵", Space: "Space",
  PageUp: "PgUp", PageDown: "PgDn", Delete: "Del" };
function prettyCombo(combo) {
  if (!combo) return `<span class="sub">none</span>`;
  return combo.split(" / ").map((one) => one.split("+").map((p) => {
    const t = p === "Mod" ? (IS_MAC ? "⌘" : "Ctrl") : p === "Alt" ? (IS_MAC ? "⌥" : "Alt") : p === "Shift" ? (IS_MAC ? "⇧" : "Shift")
      : p === "Ctrl" ? "⌃" : KEY_GLYPH[p] || p;
    return `<kbd>${esc(t)}</kbd>`;
  }).join("")).join(" / ");
}
const plainCombo = (combo) => prettyCombo(combo).replace(/<[^>]+>/g, "");

// ---------- actions used above
function stepChat(dir, unreadOnly) {
  let items = $$("#sections .section:not(.collapsed) .sb-item[data-chat]");
  if (unreadOnly) items = items.filter((b) => b.classList.contains("unread") || Number(b.dataset.chat) === currentChat);
  if (!items.length) return;
  const keys = items.map((b) => `${b.dataset.chat}:${b.dataset.topic || ""}`);
  const i = view === "chat" ? keys.indexOf(`${currentChat}:${currentTopic || ""}`) : -1;
  const next = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : (i + dir + keys.length) % keys.length;
  const ids = items.map((b) => Number(b.dataset.chat));
  navigate({ view: "chat", chatId: ids[next], topic: items[next].dataset.topic ? Number(items[next].dataset.topic) : undefined });
  $(`#sections .sb-item[data-chat="${ids[next]}"]`)?.scrollIntoView({ block: "nearest" });
}
function focusComposer() {
  const input = view === "chat" ? $("#chat-input") : (view === "manager" || !$("#pane").hidden) ? $("#input") : null;
  input?.focus();
  return !!input;
}
function toggleSidebar() {
  $(".shell").classList.toggle("no-side");
  if (window.innerWidth <= 860) $("#sidebar").classList.toggle("open");
}
function toggleFullScreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => toast("Full screen isn't allowed here", true));
}
function openSaved() {
  const saved = chatById(state?.me.peer);
  if (saved) navigate({ view: "chat", chatId: saved.id });
  else toast("Saved Messages isn't available", true);
}
function openHome() {  // Slack's Home: the sidebar of conversations
  $(".shell").classList.remove("no-side");
  if (window.innerWidth <= 860) $("#sidebar").classList.add("open");
  if (view !== "chat" && view !== "manager") navigate({ view: "manager" });
  // after the view has settled (the manager view focuses its composer)
  setTimeout(() => ($("#sections .sb-item.active") || $("#sections .sb-item") || $(".sb-top .sb-item"))?.focus(), 60);
}
let pendingJumpUnread = false;
function jumpToUnread() {  // ⌘J: the first unread message of this conversation
  if (view !== "chat") return;
  const line = $("#chat-feed .new-line");
  if (line) return line.scrollIntoView({ block: "start" });
  if (chatMeta.unread && chatMeta.readUpto) {  // it's further back than what's loaded: load around it
    pendingJumpUnread = true;
    return navigate({ view: "chat", chatId: currentChat, focus: chatMeta.readUpto });
  }
  const f = $("#chat-feed");
  f.scrollTop = f.scrollHeight;
  toast("No unread messages here");
}
function escRead() {
  if (view === "unreads") return markSelectedGroupRead();
  if (view === "chat") markRead(currentChat, true);
}
function switchTab(dir, index) {
  const bar = view === "mentions" ? $("#mention-tabs") : view === "search" ? $("#search-tabs") : null;
  if (!bar) return;
  const tabs = $$("button[data-f], button[data-t]", bar).filter((b) => !b.hidden);
  const cur = tabs.findIndex((b) => b.classList.contains("on"));
  const next = index != null ? tabs[index] : tabs[(cur + dir + tabs.length) % tabs.length];
  next?.click();
}
const FEEDS = { chat: "#chat-feed", manager: "#thread", mentions: "#mention-feed", search: "#search-feed", unreads: "#unreads-feed" };
function cycleFocus(dir) {
  const composer = view === "chat" ? $("#chat-input") : view === "manager" ? $("#input") : null;
  const regions = [$("#sections .sb-item.active") || $(".sb-top .sb-item.active") || $(".sb-top .sb-item"), $(FEEDS[view]), composer].filter(Boolean);
  const cur = regions.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
  const next = regions[(cur + dir + regions.length) % regions.length] || regions[0];
  if (!next.matches("button, textarea, input")) next.tabIndex = -1;
  next.focus();
}

// Selecting messages with ↑/↓ in a message list (chat or All unreads), like Slack.
function feedOf(el) { return el?.closest?.("#chat-feed, #unreads-feed"); }
function moveSelection(feed, dir) {
  const rows = $$(".msg", feed).filter((r) => r.offsetParent !== null);
  if (!rows.length) return;
  const cur = rows.findIndex((r) => r.classList.contains("ksel"));
  const next = rows[cur < 0 ? (dir < 0 ? rows.length - 1 : 0) : Math.max(0, Math.min(rows.length - 1, cur + dir))];
  rows.forEach((r) => r.classList.remove("ksel"));
  next.classList.add("ksel");
  next.scrollIntoView({ block: "nearest" });
}
const selectedRow = () => $("#chat-feed .msg.ksel, #unreads-feed .msg.ksel");
function selectedMessage() {
  const row = selectedRow();
  if (!row) return null;
  const id = Number(row.dataset.id);
  if (view === "chat") return chatMessages.find((m) => m.id === id);
  const g = unreadItems[Number(row.closest(".ur-group").dataset.i)];
  return g?.messages.find((m) => m.id === id) && { ...g.messages.find((m) => m.id === id), chat_id: g.chat.id };
}
function replyToSelected() {
  const m = selectedMessage();
  if (!m) return;
  if (view === "unreads") return navigate({ view: "chat", chatId: m.chat_id, focus: m.id });
  if (state.sending_enabled) setReply(m); else askInPane(`Explain this message: chat_id ${currentChat}, message_id ${m.id}.`, chatById(currentChat)?.name);
}
async function saveSelected() {
  const m = selectedMessage();
  if (!m) return;
  try {
    await api(`/api/chat/${m.chat_id ?? currentChat}/save/${m.id}`, { method: "POST" });
    toast("✓ Saved to <b>Saved Messages</b>");
  } catch (e) { toast(`Couldn't save: ${esc(e.message)}`, true); }
}
async function markUnread(chatId) {
  if (!state.mark_read_enabled) return toast("Marking unread is off (mark_read_enabled in config.toml)", true);
  try {
    await api(`/api/chat/${chatId}/unread`, { method: "POST" });
  } catch (e) { return toast(`Couldn't mark unread: ${esc(e.message)}`, true); }
  toast(`Marked <b>${esc(chatById(chatId)?.name || "chat")}</b> as unread (Telegram marks the whole chat)`);
  loadState();
}
function markSelectedGroupRead() {
  const g = selectedRow()?.closest(".ur-group") || $("#unreads-feed .ur-group:focus-within");
  const id = g && unreadItems[Number(g.dataset.i)]?.chat.id;
  if (id) markRead(id).then(() => g.remove());
}
function toggleGroup(open) {
  const g = selectedRow()?.closest(".ur-group");
  if (!g) return;
  g.classList.toggle("collapsed-group", !open);
  if (!open) { $$(".msg", g).forEach((r) => r.classList.remove("ksel")); $(".ur-head", g).tabIndex = -1; }
}

// Formatting: Telegram markdown (**bold**, __italic__, ++underline++, ~~strike~~, `code`, ```block```,
// [text](url)). Edits go through insertText so ⌘Z undoes them, like Slack's "undo formatting".
function replaceRange(t, s, e, text, selStart, selEnd) {
  t.focus();
  t.setSelectionRange(s, e);
  if (!document.execCommand("insertText", false, text)) t.setRangeText(text, s, e, "end");
  if (selStart != null) t.setSelectionRange(selStart, selEnd ?? selStart);
  t.dispatchEvent(new Event("input"));
}
function wrapSel(t, before, after = before) {
  const s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e);
  if (sel && t.value.slice(s - before.length, s) === before && t.value.slice(e, e + after.length) === after) {  // toggle off
    replaceRange(t, s - before.length, e + after.length, sel, s - before.length, e - before.length);
  } else {
    replaceRange(t, s, e, before + sel + after, s + before.length, s + before.length + sel.length);
  }
}
function prefixLines(t, prefix) {
  const v = t.value;
  const s = v.lastIndexOf("\n", t.selectionStart - 1) + 1;
  let e = v.indexOf("\n", t.selectionEnd);
  if (e < 0) e = v.length;
  const text = v.slice(s, e).split("\n").map((l, i) => prefix(i) + l).join("\n");
  replaceRange(t, s, e, text, s + text.length);
}
function addLink(t) {
  const s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e);
  const isUrl = /^https?:\/\//.test(sel);
  const text = isUrl ? sel : sel || "link text";
  const url = isUrl ? sel : "https://";
  const urlStart = s + text.length + 3;
  replaceRange(t, s, e, `[${text}](${url})`, isUrl ? s + text.length * 2 + 4 : urlStart, isUrl ? undefined : urlStart + url.length);
}
function applyMarkdown(t) {  // Slack-style *bold* _italic_ ~strike~ → Telegram's doubled markers
  const all = t.selectionStart === t.selectionEnd;
  const s = all ? 0 : t.selectionStart, e = all ? t.value.length : t.selectionEnd;
  const out = t.value.slice(s, e)
    .replace(/(^|[^*\w])\*(?!\*)([^*\n]+?)\*(?!\*)/g, "$1**$2**")
    .replace(/(^|[^_\w])_(?!_)([^_\n]+?)_(?!_)/g, "$1__$2__")
    .replace(/(^|[^~\w])~(?!~)([^~\n]+?)~(?!~)/g, "$1~~$2~~");
  replaceRange(t, s, e, out, s + out.length);
}
function selectToLine(t, dir) {
  const v = t.value;
  if (dir < 0) t.setSelectionRange(v.lastIndexOf("\n", t.selectionStart - 1) + 1, t.selectionEnd, "backward");
  else { let end = v.indexOf("\n", t.selectionEnd); if (end < 0) end = v.length; t.setSelectionRange(t.selectionStart, end, "forward"); }
}

// ---------- mouse shortcuts
$("#sections").addEventListener("click", (e) => {  // ⌥-click a section: expand or collapse them all
  const head = e.target.closest("[data-toggle]");
  if (!head || !e.altKey) return;
  e.stopImmediatePropagation();
  const collapse = !collapsed[head.dataset.toggle];
  for (const [key] of SECTIONS) collapsed[key] = collapse;
  renderSidebar();
}, true);
document.addEventListener("click", (e) => {  // ⌥-click a message: mark unread
  if (!e.altKey || e.target.closest("a, button, .att")) return;
  const row = e.target.closest("#chat-feed .msg, #unreads-feed .msg");
  if (!row) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const chatId = view === "chat" ? currentChat : unreadItems[Number(row.closest(".ur-group").dataset.i)]?.chat.id;
  if (chatId) markUnread(chatId);
}, true);

// ---------- dispatch
function isTyping(e) {
  const t = e.target;
  return t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable;
}
const overlayOpen = () => ["#lightbox", "#switcher", "#shortcuts", "#details", "#confirm"].some((s) => !$(s).hidden);
let recording = null;  // action id being rebound
document.addEventListener("keydown", (e) => {
  if (recording) return;  // the shortcuts dialog handles it
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  if (e.key === "Escape" && !e.shiftKey) {  // close the topmost thing first, like Slack
    if (!$("#ctx-menu").hidden) { closeMenu(); return; }
    if (!$("#confirm").hidden) { confirmBox.cancel?.(); return; }
    if (!$("#lightbox").hidden) { $("#lightbox").hidden = true; return; }
    if (!$("#switcher").hidden) { closeSwitcher(); return; }
    if (!$("#shortcuts").hidden) { closeShortcuts(); return; }
    if (!$("#details").hidden) { closeDetails(); return; }
    if (e.target.id === "search") return;  // the search box closes its own dropdown
    if (view === "chat" && replyTo) { replyTo = null; updateComposer(); return; }
    if (!$("#pane").hidden && !isTyping(e) && view !== "unreads") { closePane(); return; }
    if (isTyping(e) && e.target.value) { e.target.blur(); return; }  // leave the draft alone
  }
  if (!overlayOpen() && !isTyping(e)) {
    // ↑/↓ move between messages in a message list; ←/→ open or collapse a group in All unreads
    const feed = feedOf(document.activeElement);
    if (feed && plain && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      return moveSelection(feed, e.key === "ArrowUp" ? -1 : 1);
    }
    if (feed?.id === "unreads-feed" && plain && (e.key === "ArrowLeft" || (e.key === "ArrowRight" && selectedRow()?.closest(".collapsed-group")))) {
      e.preventDefault();
      return toggleGroup(e.key === "ArrowRight");
    }
    // ←/→ with the sidebar focused resize it
    if (plain && (e.key === "ArrowLeft" || e.key === "ArrowRight") && document.activeElement?.closest("#sidebar")) {
      e.preventDefault();
      return resizeSidebar(e.key === "ArrowLeft" ? -16 : 16);
    }
    // Ctrl+2…9 switch to that tab
    if (e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[2-9]$/.test(e.code) && (view === "mentions" || view === "search")) {
      e.preventDefault();
      return switchTab(0, Number(e.code.slice(5)) - 1);
    }
  }
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (/^Mod\+(Alt\+)?[1-9]$/.test(combo) && !overlayOpen()) {  // Slack: ⌘[number] switches workspace
    e.preventDefault();
    return folderByNumber(Number(combo.slice(-1)));
  }
  const typing = isTyping(e);
  const msgSelected = !typing && !!selectedRow() && !!feedOf(document.activeElement);
  const act = ACTIONS.find((a) => bindingsOf(a).includes(combo) && (a.when !== "message" || msgSelected) && (a.when !== "composer" || typing));
  if (!act) {
    // Slack: start typing anywhere and it goes into the message box.
    if (!typing && !overlayOpen() && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) focusComposer();
    return;
  }
  if (act.when === "composer" && e.target.tagName !== "TEXTAREA") return;
  if (act.when === "page" && typing && e.target.value) return;
  if (act.id === "markRead" && ((view !== "chat" && view !== "unreads") || e.target.closest?.(".inline-reply"))) return;  // let Esc reach the field
  if (act.when === "any" && typing && !/(^|\+)(Mod|Ctrl|Alt)\+/.test(combo) && !/^(Shift\+)?(F\d+|Escape)$/.test(combo)) return;
  if (overlayOpen() && !["quickSwitcher", "shortcuts", "prefs", "help"].includes(act.id)) return;
  e.preventDefault();
  e.stopPropagation();
  act.run(e.target);
}, true);

function resizeSidebar(delta) {
  const shell = $(".shell");
  const cur = parseInt(getComputedStyle(shell).getPropertyValue("--side-w")) || 264;
  const w = Math.max(180, Math.min(440, cur + delta));
  shell.style.setProperty("--side-w", w + "px");
  store("sidebarWidth", w);
}
{ const w = store("sidebarWidth"); if (w) $(".shell").style.setProperty("--side-w", w + "px"); }

async function loadPrefs() {
  try { const p = await api("/api/prefs"); overrides = p.shortcuts || {}; uiPrefs = p.ui || {}; } catch { overrides = {}; }
  if (typeof applyCalm === "function") applyCalm();
  renderSidebar();
  const jump = bindingOf(action("quickSwitcher"));
  $("#search-kbd").textContent = jump ? `${plainCombo(jump)} to jump` : "";
}
async function savePrefs() {
  try { await postJson("/api/prefs", { shortcuts: overrides }); } catch (e) { toast(`Couldn't save shortcuts: ${esc(e.message)}`, true); }
  loadPrefs();
}

function openShortcuts() {
  closeSwitcher();
  $("#shortcuts").hidden = false;
  renderShortcuts();
}
function closeShortcuts() { $("#shortcuts").hidden = true; recording = null; }
function renderShortcuts() {
  const groups = [...new Set([...ACTIONS.map((a) => a.group), ...FIXED.map((f) => f[0])])];
  $("#sc-list").innerHTML = groups.map((g) => {
    const rows = ACTIONS.filter((a) => a.group === g).map((a) => {
      const custom = a.id in overrides;
      const b = bindingsOf(a);
      const alt = !custom && b.length > 1 ? `<span class="alt">also ${b.slice(1).map(plainCombo).join(", ")}</span>` : "";
      return `<div class="sc-row ${custom ? "custom" : ""}" data-id="${a.id}"><span class="lbl">${esc(a.label)}</span>${alt}
        <button class="reset" data-reset="${a.id}" title="Default: ${esc(plainCombo(a.def) || "none")}">Reset</button>
        <button class="combo ${recording === a.id ? "rec" : ""}" data-rec="${a.id}">${recording === a.id ? "Press keys… (Esc cancels, ⌫ clears)" : prettyCombo(b[0])}</button></div>`;
    }).join("") + FIXED.filter((f) => f[0] === g).map(([, label, combo]) =>
      `<div class="sc-row"><span class="lbl">${esc(label)}</span><span class="combo">${prettyCombo(combo)}</span></div>`).join("");
    return `<div class="sc-group">${esc(g)}</div>${rows}`;
  }).join("") + `<div class="sc-group">Slack shortcuts with no equivalent here</div>` +
    NOT_AVAILABLE.map(([label, combo, why]) => `<div class="sc-row na"><span class="lbl">${esc(label)} <span class="alt">· ${esc(why)}</span></span><span class="combo">${prettyCombo(combo)}</span></div>`).join("");
}
$("#sc-list").addEventListener("click", (e) => {
  const rec = e.target.closest("[data-rec]");
  const reset = e.target.closest("[data-reset]");
  if (rec) { recording = recording === rec.dataset.rec ? null : rec.dataset.rec; renderShortcuts(); }
  else if (reset) { delete overrides[reset.dataset.reset]; renderShortcuts(); savePrefs(); }
});
document.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape" && !e.shiftKey) { recording = null; renderShortcuts(); return; }
  const id = recording;
  if (e.key === "Backspace" || e.key === "Delete") {
    overrides[id] = "";
  } else {
    const combo = comboFromEvent(e);
    if (!combo) return;  // only a modifier so far
    const clash = ACTIONS.find((a) => a.id !== id && bindingsOf(a).includes(combo));
    if (clash) {  // move the key over; the other action keeps any key it still has
      overrides[clash.id] = bindingsOf(clash).find((c) => c !== combo) || "";
      toast(`${esc(plainCombo(combo))} moved from “${esc(clash.label)}”`);
    }
    overrides[id] = combo;
  }
  if (overrides[id] === action(id).def && !action(id).alt.length) delete overrides[id];
  recording = null;
  renderShortcuts();
  savePrefs();
}, true);
$("#sc-reset").addEventListener("click", () => { overrides = {}; renderShortcuts(); savePrefs(); });
$("#shortcuts").addEventListener("mousedown", (e) => { if (e.target.id === "shortcuts" || e.target.closest("[data-close]")) closeShortcuts(); });
$("#confirm").addEventListener("mousedown", (e) => { if (e.target.id === "confirm") confirmBox.cancel?.(); });
$("#open-shortcuts").addEventListener("click", () => openShortcuts());
$("#ws-menu").addEventListener("click", () => openShortcuts());

// ================================================================== start
loadPrefs();
loadAllChats();
loadState();
