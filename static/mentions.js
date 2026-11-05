"use strict";
// @-mentions in every message box, like Slack: type @ and pick a person. People with a username are
// tagged as @username; people without one are tagged by name (a Telegram "text mention"), which the
// composer writes as @Name and turns into [Name](tg://user?id=…) when the message is sent.

const mentionPicks = new Map();  // chat id -> Map("@Name" -> {id, name})
let atPop = null;                // {input, chatId, start, items, sel}

function chatIdForInput(input) {
  const act = input.closest("[data-key]");
  if (act) return Number(act.dataset.key.split(":")[0]);  // inline reply in Activity
  if (input.id === "thread-input" && typeof threadView !== "undefined" && threadView) return threadView.chatId;
  return currentChat;
}
const isMessageBox = (el) => el?.tagName === "TEXTAREA" && el.closest(".composer") && el.id !== "input";  // not the Inbox Manager box

// The "@query" right before the caret, if any.
function atQuery(input) {
  const upto = input.value.slice(0, input.selectionStart);
  const m = upto.match(/(^|[\s(])@([^\s@]{0,32})$/u);
  return m ? { start: upto.length - m[2].length - 1, q: m[2] } : null;
}

let atTimer = null, atSeq = 0;
document.addEventListener("input", (e) => {
  const input = e.target;
  if (!isMessageBox(input)) return;
  const hit = atQuery(input);
  if (!hit) return closeAtPop();
  const chatId = chatIdForInput(input);
  if (!chatId) return;
  clearTimeout(atTimer);
  atTimer = setTimeout(() => loadAtPop(input, chatId, hit), 120);
});

async function loadAtPop(input, chatId, hit) {
  const seq = ++atSeq;
  let members = [];
  try { members = (await api(`/api/chat/${chatId}/members?q=${encodeURIComponent(hit.q)}`)).members; } catch { /* no list */ }
  if (seq !== atSeq || document.activeElement !== input) return;
  const still = atQuery(input);
  if (!still || still.start !== hit.start) return;
  if (!members.length) return closeAtPop();
  atPop = { input, chatId, start: hit.start, items: members, sel: 0 };
  renderAtPop();
}

function renderAtPop() {
  let el = $("#at-pop");
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", `<div class="at-pop" id="at-pop" role="listbox"></div>`);
    el = $("#at-pop");
    el.addEventListener("mousedown", (e) => {  // mousedown: before the textarea loses focus
      const it = e.target.closest(".pop-item");
      if (!it) return;
      e.preventDefault();
      atPop.sel = Number(it.dataset.i);
      pickAt();
    });
  }
  const p = atPop;
  el.innerHTML = `<div class="pop-head">People in this conversation</div>` + p.items.map((u, i) =>
    `<div class="pop-item ${i === p.sel ? "sel" : ""}" data-i="${i}" role="option">${av(u, "s24")}
      <span class="nm"><b>${esc(u.name)}</b>${u.bot ? ` <span class="sub">bot</span>` : ""}</span>
      <span class="sub">${u.username ? "@" + esc(u.username) : "no username · tagged by name"}</span></div>`).join("");
  const r = p.input.getBoundingClientRect();
  el.hidden = false;
  el.style.left = Math.max(8, r.left) + "px";
  el.style.width = Math.min(420, r.width) + "px";
  el.style.top = Math.max(8, r.top - el.offsetHeight - 6) + "px";
  $(".pop-item.sel", el)?.scrollIntoView({ block: "nearest" });
}
function closeAtPop() {
  atPop = null;
  const el = $("#at-pop");
  if (el) el.hidden = true;
}
function pickAt() {
  const p = atPop;
  if (!p) return;
  const u = p.items[p.sel];
  const input = p.input;
  const end = input.selectionStart;
  let label;
  if (u.username) label = "@" + u.username;
  else {
    label = "@" + u.name.replace(/[[\]()]/g, "").trim();
    if (!mentionPicks.has(p.chatId)) mentionPicks.set(p.chatId, new Map());
    mentionPicks.get(p.chatId).set(label, { id: u.id, name: label.slice(1) });
  }
  input.setSelectionRange(p.start, end);
  if (!document.execCommand("insertText", false, label + " ")) input.setRangeText(label + " ", p.start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  closeAtPop();
  input.focus();
}

// Arrow keys / Enter / Tab / Esc while the list is open (before the app's own shortcuts see them).
window.addEventListener("keydown", (e) => {
  if (!atPop || e.target !== atPop.input) return;
  const n = atPop.items.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") atPop.sel = (atPop.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n, renderAtPop();
  else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") pickAt();
  else if (e.key === "Escape") closeAtPop();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
document.addEventListener("focusout", (e) => { if (atPop && e.target === atPop.input) setTimeout(() => { if (document.activeElement !== atPop?.input) closeAtPop(); }, 150); });
window.addEventListener("resize", closeAtPop);

// When sending: @Name tags picked from the list become real Telegram tags.
function expandMentions(chatId, text) {
  const picks = mentionPicks.get(Number(chatId));
  if (!picks?.size) return text;
  for (const [label, u] of [...picks].sort((a, b) => b[0].length - a[0].length)) {
    text = text.split(label).join(`[${u.name}](tg://user?id=${u.id})`);
  }
  return text;
}
