"use strict";
// Pictures and files in the message box, like Slack: paste (⌘V), drop, or the ＋ by Send / ⌘O. They wait in
// a tray above the box with previews; Enter sends them, with what you typed as the caption.
// Works in the channel's box and in the thread pane's box (where they go into the thread).

const trays = { chat: [], thread: [] };  // pending File objects per message box
const MAX_FILE = 50 * 1024 * 1024;

const formOf = (kind) => (kind === "thread" ? $("#thread-composer") : $("#chat-composer"));
const kindOf = (el) => (el?.closest?.("#thread-composer, #pane") ? "thread" : "chat");
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function addFiles(kind, files) {
  if (!state?.sending_enabled) return toast("Sending is off: set sending_enabled = true in config.toml", true);
  if (kind === "chat" && view !== "chat") return toast("Open a conversation first");
  if (kind === "thread" && !threadView) return;
  for (const f of files) {
    if (!f || !f.size) continue;
    if (f.size > MAX_FILE) { toast(`${esc(f.name)} is larger than 50 MB`, true); continue; }
    // pasted screenshots arrive as "image.png": give them a readable name
    const named = /^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? new File([f], `Screenshot ${new Date().toLocaleString().replace(/[/:]/g, "-")}.${f.name.split(".").pop()}`, { type: f.type }) : f;
    trays[kind].push({ file: named, url: named.type.startsWith("image/") ? URL.createObjectURL(named) : null });
  }
  renderTray(kind);
  (kind === "thread" ? $("#thread-input") : $("#chat-input"))?.focus();
}
function removeFile(kind, i) {
  const [it] = trays[kind].splice(i, 1);
  if (it?.url) URL.revokeObjectURL(it.url);
  renderTray(kind);
}
function clearTray(kind) {
  for (const it of trays[kind]) if (it.url) URL.revokeObjectURL(it.url);
  trays[kind] = [];
  renderTray(kind);
}
function renderTray(kind) {
  const form = formOf(kind);
  if (!form) return;
  let tray = $(".attach-tray", form);
  const items = trays[kind];
  if (!items.length) { tray?.remove(); form.classList.remove("has-files"); return; }
  if (!tray) { form.insertAdjacentHTML("afterbegin", `<div class="attach-tray"></div>`); tray = $(".attach-tray", form); }
  form.classList.add("has-files");
  tray.innerHTML = items.map((it, i) => `<div class="att-item" title="${esc(it.file.name)} · ${fmtSize(it.file.size)}">
      ${it.url ? `<img src="${it.url}" alt="">` : `<span class="att-doc">📄<span>${esc(it.file.name)}</span><small>${fmtSize(it.file.size)}</small></span>`}
      <button type="button" class="att-x" data-rm="${i}" title="Remove">✕</button></div>`).join("") +
    `<span class="att-hint">${items.length === 1 ? "1 file" : `${items.length} files`} · Enter to send${kind === "thread" ? " to the thread" : ""}</span>`;
}
document.addEventListener("click", (e) => {
  const x = e.target.closest(".att-x");
  if (x) { e.preventDefault(); removeFile(kindOf(x), Number(x.dataset.rm)); }
});

// ---------------------------------------------------------------- sending
async function sendFiles(kind, caption, chatReplyTo = null) {
  const items = trays[kind].slice();
  if (!items.length) return;
  const tv = kind === "thread" ? threadView : null;
  const chatId = tv ? tv.chatId : currentChat;
  const replyId = tv ? (tv.target || tv.root)?.id : chatReplyTo;
  clearTray(kind);
  let cap = caption ? expandMentions(chatId, caption) : "";
  let sent = 0;
  for (const { file } of items) {
    toast(`Sending <b>${esc(file.name)}</b>…`, false, 120000);
    try {
      const r = await fetch(`/api/chat/${chatId}/upload`, { method: "POST", body: await file.arrayBuffer(),
        headers: { ...GUARD, "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name), "X-Caption": encodeURIComponent(cap),
          "X-Topic": String(chatId === currentChat ? currentTopic || "" : ""), "X-Reply-To": String(replyId || ""), "X-Thread-Root": String(tv?.rootId || "") } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      const { message } = await r.json();
      cap = "";  // the caption goes with the first file only
      sent++;
      lastSent = { chatId, msgId: message.id, at: Date.now() };
      if (tv) { if (typeof addToThread === "function") addToThread(message); }
      else if (currentChat === chatId && view === "chat" && !chatMessages.some((m) => m.id === message.id)) {
        chatMessages.push(message);
        rerenderChat();
        $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
      }
    } catch (e) {
      toast(`Not sent: ${esc(file.name)}: ${esc(e.message)}`, true, 8000);
      return;
    }
  }
  toast(`✓ Sent ${sent === 1 ? esc(items[0].file.name) : `${sent} files`}`);
}
// Enter / ➤ with files waiting: send them (the text becomes the caption). Runs before the box's own handler.
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!form.matches?.("#chat-composer, #thread-composer")) return;
  const kind = form.id === "thread-composer" ? "thread" : "chat";
  if (!trays[kind].length) return;
  if (kind === "chat" && typeof composeMode !== "undefined" && composeMode !== "send") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const input = $("textarea", form);
  const caption = input.value.trim();
  setInput(form, input, "");
  if (kind === "thread" && threadView) threadView.draft = "";
  const chatReply = kind === "chat" && replyTo ? replyTo.id : null;  // "Replying to…" in the channel box
  if (chatReply) { replyTo = null; updateComposer(); }
  sendFiles(kind, caption, chatReply);
}, true);

// ---------------------------------------------------------------- the three ways in
// 1. Paste (screenshots, copied images, copied files from Finder)
document.addEventListener("paste", (e) => {
  const box = e.target.closest?.("#chat-composer, #thread-composer");
  if (!box) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) for (const it of e.clipboardData?.items || []) if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
  if (!files.length) return;
  e.preventDefault();
  addFiles(kindOf(box), files);
});
// 2. Drop: anywhere on the conversation or the thread pane. Elsewhere, never let the app open the file.
document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types?.includes?.("Files") && !Array.from(e.dataTransfer?.types || []).includes("Files")) return;
  e.preventDefault();
  const zone = e.target.closest?.("#view-chat, #pane");
  document.querySelectorAll(".drop").forEach((el) => { if (el !== zone) el.classList.remove("drop"); });
  if (zone && state?.sending_enabled && (zone.id !== "pane" || threadView)) { zone.classList.add("drop"); e.dataTransfer.dropEffect = "copy"; }
  else e.dataTransfer.dropEffect = "none";
}, true);
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.querySelectorAll(".drop").forEach((el) => el.classList.remove("drop")); }, true);
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  document.querySelectorAll(".drop").forEach((el) => el.classList.remove("drop"));
  const zone = e.target.closest?.("#view-chat, #pane");
  if (!zone) return;
  addFiles(zone.id === "pane" ? "thread" : "chat", [...e.dataTransfer.files]);
}, true);
// 3. The ＋ menu and ⌘O open the file picker for the box you are in
const attachPicker = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true });
document.body.appendChild(attachPicker);
let pickerKind = "chat";
attachPicker.addEventListener("change", () => { addFiles(pickerKind, [...attachPicker.files]); attachPicker.value = ""; });
function pickFiles(kind = "chat", accept = "") {
  if (kind === "chat" && view !== "chat") return toast("Open a conversation first");
  if (!needWrites()) return;
  pickerKind = kind;
  attachPicker.accept = accept;
  attachPicker.click();
}
uploadFile = () => pickFiles(kindOf(document.activeElement));  // ⌘O (slack.js) now fills the tray too
// A "+" next to Send, like Slack, opens: photo or video / file. (Paste and drop still work anywhere.)
const PLUS_HTML = `<button type="button" class="plus-btn" data-plus title="Attach a photo or a file (⌘O) · you can also paste or drop them">＋</button>`;
function plusMenu(btn) {
  const kind = kindOf(btn);
  let menu = $("#plus-menu");
  if (!menu) {
    document.body.insertAdjacentHTML("beforeend", `<div class="ctx-menu plus-menu" id="plus-menu" hidden></div>`);
    menu = $("#plus-menu");
    menu.addEventListener("click", (e) => {
      const it = e.target.closest("[data-pick]");
      if (!it) return;
      menu.hidden = true;
      pickFiles(menu.dataset.kind, it.dataset.pick === "media" ? "image/*,video/*" : "");
    });
    document.addEventListener("mousedown", (e) => { if (!e.target.closest("#plus-menu, [data-plus]")) menu.hidden = true; });
  }
  if (!menu.hidden && menu.dataset.kind === kind) { menu.hidden = true; return; }
  menu.dataset.kind = kind;
  menu.innerHTML = `<button class="mi" data-pick="media"><span class="pm-ico">🖼</span>Photo or video</button>
    <button class="mi" data-pick="file"><span class="pm-ico">📄</span>File <span class="k">${plainCombo("Mod+O")}</span></button>
    <div class="sep"></div><div class="pm-note">Or paste (⌘V) / drop them into the conversation</div>`;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, r.top - menu.offsetHeight - 6) + "px";
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-plus]"); if (b) { e.preventDefault(); plusMenu(b); } });
function addPlus(form) {
  const send = form && $(".composer-bar button.send", form);
  if (send && !$("[data-plus]", form)) send.insertAdjacentHTML("beforebegin", PLUS_HTML);
}
addPlus($("#chat-composer"));
// The thread pane's box is rebuilt on every update: give it its + and its tray back each time.
const _renderThreadAttach = renderThread;
renderThread = function () {
  _renderThreadAttach();
  addPlus($("#thread-composer"));
  const bar = $("#thread-composer .composer-bar");
  if (bar && !$(".pk-btn", bar)) {  // emoji, stickers and GIFs in the thread too
    bar.insertAdjacentHTML("afterbegin", `<button type="button" class="pk-btn" title="Emoji, stickers and GIFs (⌘⌥E)">☺</button>`);
    $(".pk-btn", bar).addEventListener("click", () => togglePicker("thread"));
  }
  renderTray("thread");
  if (typeof placePicker === "function") placePicker();
};
// Switching conversations or closing the thread drops what was waiting.
const _openChatAttach = openChat;
openChat = async function (id, opts) { if (id !== currentChat) clearTray("chat"); return _openChatAttach(id, opts); };
const _closeThreadAttach = closeThread;
closeThread = function () { trays.thread = []; return _closeThreadAttach(); };
