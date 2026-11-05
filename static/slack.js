"use strict";
// Slack features that need Telegram write actions or extra views: message actions (edit, delete,
// unsend, forward, pin, react, remind), upload, status (bio), huddles, folders-as-workspaces,
// the More and Files views, notes ("canvas") and snippets. Loaded after app.js and uses its globals.
// Everything here runs only when the user presses a key or clicks; the manager agent can't reach it.

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "🙏", "👏", "🎉", "😮", "😢", "✅", "👀", "💯"];
let lastSent = null;  // {chatId, msgId, at}: what ⌘Z in an empty message box unsends

function needWrites() {
  if (state?.sending_enabled) return true;
  toast("That changes Telegram, which needs sending_enabled = true in config.toml", true);
  return false;
}
const msgPost = (chatId, msgId, op, body = {}) => postJson(`/api/chat/${chatId}/msg/${msgId}/${op}`, body);
function rowOf(msgId) { return $(`#chat-feed .msg[data-id="${msgId}"]`); }
function rerenderChat() {
  const feed = $("#chat-feed");
  const top = feed.scrollTop;
  renderChatFeed();
  feed.scrollTop = top;
}
// The message to act on: the keyboard-selected one, or the one whose menu was opened.
function targetMessage(m) {
  if (m && m.id != null) return m;
  return selectedMessage();
}

// ---------------------------------------------------------------- edit (E)
function editMessage(m) {
  m = targetMessage(m);
  if (!m || view !== "chat") return;
  if (!m.out) return toast("You can only edit your own messages", true);
  if (!needWrites()) return;
  const row = rowOf(m.id);
  const text = $(".tg-text", row);
  if (!row || !text || $(".edit-box", row)) return;
  text.hidden = true;
  text.insertAdjacentHTML("afterend", `<div class="edit-box"><form class="composer"><textarea rows="1"></textarea>
    <div class="composer-bar"><span class="hint">Enter to save · Esc to cancel</span><button type="button" class="cancel">Cancel</button><button type="submit" class="send">✓</button></div></form></div>`);
  const box = $(".edit-box", row);
  const input = $("textarea", box);
  input.value = m.text || "";
  autosize(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const close = () => { box.remove(); text.hidden = false; };
  $(".cancel", box).addEventListener("click", close);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } });
  wireComposer($("form", box), input, async (v) => {
    try {
      const res = await msgPost(currentChat, m.id, "edit", { text: expandMentions(currentChat, v) });
      Object.assign(m, { text: res.message.text, edited: true });
      rerenderChat();
      toast("✓ Message edited");
    } catch (e) {
      setInput($("form", box), input, v);
      toast(`Not edited: ${esc(e.message)}`, true);
    }
  });
}

// ---------------------------------------------------------------- delete (Delete) and unsend (⌘Z)
async function deleteMessage(m, { ask = true } = {}) {
  m = targetMessage(m);
  if (!m || view !== "chat") return;
  if (!m.out) return toast("You can only delete your own messages", true);
  if (!needWrites()) return;
  if (ask && !(await confirmBox("Delete message?", `This deletes it for everyone in <b>${esc(chatById(currentChat)?.name || "this chat")}</b>. It can't be undone.`, "Delete"))) return;
  try {
    await msgPost(currentChat, m.id, "delete");
  } catch (e) { return toast(`Not deleted: ${esc(e.message)}`, true); }
  chatMessages = chatMessages.filter((x) => x.id !== m.id);
  rerenderChat();
  toast(ask ? "Message deleted" : "Message unsent");
}
// ⌘Z: unsend the message you just sent (empty box, same chat, within 2 minutes); otherwise undo text.
function unsendOrUndo(t) {
  const fresh = lastSent && lastSent.chatId === currentChat && Date.now() - lastSent.at < 120000;
  if (view === "chat" && t?.id === "chat-input" && !t.value && fresh) {
    const m = chatMessages.find((x) => x.id === lastSent.msgId);
    lastSent = null;
    if (m) return deleteMessage(m, { ask: false });
  }
  document.execCommand("undo");
}

// ---------------------------------------------------------------- forward (F)
let forwardSource = null;
function forwardMessage(m) {
  m = targetMessage(m);
  if (!m || !needWrites()) return;
  forwardSource = { chatId: m.chat_id ?? currentChat, msgId: m.id };
  openSwitcher("forward");
}
async function finishForward(chat) {
  const src = forwardSource;
  forwardSource = null;
  if (!src) return;
  try {
    const r = await msgPost(src.chatId, src.msgId, "forward", { to: chat.id });
    toast(`✓ Forwarded to <b>${esc(r.to || chat.name)}</b>`);
    navigate({ view: "chat", chatId: chat.id });  // go see it there, like Telegram
  } catch (e) { toast(`Not forwarded: ${esc(e.message)}`, true); }
}

// ---------------------------------------------------------------- pin (P)
async function togglePin(m) {
  m = targetMessage(m);
  if (!m || view !== "chat" || !needWrites()) return;
  try {
    await msgPost(currentChat, m.id, "pin", { pinned: !m.pinned });
  } catch (e) { return toast(`Couldn't ${m.pinned ? "unpin" : "pin"}: ${esc(e.message)}`, true); }
  m.pinned = !m.pinned;
  rerenderChat();
  toast(m.pinned ? "📌 Pinned" : "Unpinned");
}

// ---------------------------------------------------------------- react (R, ⌘⇧\)
function reactPicker(m, anchor) {
  m = targetMessage(m);
  if (!m || !needWrites()) return;
  const menu = $("#ctx-menu");
  menu.innerHTML = `<div class="mh">React to ${esc(m.out ? "your message" : m.sender?.name || "message")}</div>
    <div class="emoji-grid">${QUICK_REACTIONS.map((e) => `<button class="emo" data-emo="${e}">${e}</button>`).join("")}</div>
    ${(m.reactions || []).some((r) => r.mine) ? `<div class="sep"></div><button class="mi" data-emo="">Remove my reaction</button>` : ""}`;
  menu.dataset.react = `${m.chat_id ?? currentChat}:${m.id}`;
  const r = (anchor || rowOf(m.id) || $("#chat-feed")).getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(r.right - 300, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(r.top + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
  $(".emo", menu)?.focus();
  reactTarget = m;
}
let reactTarget = null;
$("#ctx-menu").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-emo]");
  if (!b || !$("#ctx-menu").dataset.react) return;
  e.stopImmediatePropagation();
  const [chatId, msgId] = $("#ctx-menu").dataset.react.split(":").map(Number);
  delete $("#ctx-menu").dataset.react;
  closeMenu();
  await setReaction(reactTarget, chatId, msgId, b.dataset.emo || null);
}, true);
async function setReaction(m, chatId, msgId, emoji) {
  try {
    await msgPost(chatId, msgId, "react", { emoji });
  } catch (e) { return toast(`Couldn't react: ${esc(e.message)}`, true); }
  if (m) {  // Telegram allows one reaction per person (more with Premium): mirror that locally
    m.reactions = (m.reactions || []).map((r) => (r.mine ? { ...r, count: r.count - 1, mine: false } : r)).filter((r) => r.count > 0);
    if (emoji) {
      const r = m.reactions.find((x) => x.emoji === emoji);
      if (r) { r.count++; r.mine = true; } else m.reactions.push({ emoji, count: 1, mine: true });
    }
    if (view === "chat" && chatId === currentChat) rerenderChat();
  }
  toast(emoji ? `Reacted ${emoji}` : "Reaction removed");
}
function reactToLast() {  // ⌘⇧\ : react to the latest message in this conversation
  if (view !== "chat" || !chatMessages.length) return;
  const m = chatMessages[chatMessages.length - 1];
  reactPicker(m, rowOf(m.id));
}
// clicking a reaction chip toggles your reaction, like Slack
$("#chat-feed").addEventListener("click", (e) => {
  const chip = e.target.closest(".react-chip");
  if (!chip) return;
  e.stopPropagation();
  if (!needWrites()) return;
  const m = chatMessages.find((x) => x.id === Number(chip.closest(".msg").dataset.id));
  if (m) setReaction(m, currentChat, m.id, chip.classList.contains("mine") ? null : chip.dataset.emo);
});

// ---------------------------------------------------------------- remind (M)
const REMIND_OPTIONS = [["In 20 minutes", 20], ["In 1 hour", 60], ["In 3 hours", 180], ["Tomorrow", null], ["Next week", 7 * 24 * 60]];
function minutesUntilTomorrow9() {
  const now = new Date();
  const t = new Date(now); t.setDate(now.getDate() + 1); t.setHours(9, 0, 0, 0);
  return Math.round((t - now) / 60000);
}
function remindMe(m, anchor) {
  m = targetMessage(m);
  if (!m || !needWrites()) return;
  const menu = $("#ctx-menu");
  menu.innerHTML = `<div class="mh">Remind me about this message</div>` +
    REMIND_OPTIONS.map(([label, mins]) => `<button class="mi" data-remind="${mins ?? "tomorrow"}">${label}${mins == null ? " at 9:00" : ""}</button>`).join("");
  menu.dataset.remind = `${m.chat_id ?? currentChat}:${m.id}`;
  const r = (anchor || rowOf(m.id) || $("#chat-feed")).getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(r.right - 260, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(r.top + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
  $(".mi", menu)?.focus();
}
$("#ctx-menu").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remind]");
  if (!b || !$("#ctx-menu").dataset.remind) return;
  e.stopImmediatePropagation();
  const [chatId, msgId] = $("#ctx-menu").dataset.remind.split(":").map(Number);
  delete $("#ctx-menu").dataset.remind;
  closeMenu();
  const minutes = b.dataset.remind === "tomorrow" ? minutesUntilTomorrow9() : Number(b.dataset.remind);
  try {
    const r = await msgPost(chatId, msgId, "remind", { minutes });
    toast(`⏰ I'll remind you ${esc(r.at)} (a scheduled message in Saved Messages)`);
  } catch (err) { toast(`Couldn't set the reminder: ${esc(err.message)}`, true); }
}, true);

// ---------------------------------------------------------------- per-message "⋯" menu (mouse access to all of the above)
function messageMenu(m, anchor) {
  const menu = $("#ctx-menu");
  const k = (id) => { const a = action(id); const b = a && bindingOf(a); return b ? `<span class="k">${plainCombo(b)}</span>` : ""; };
  menu.innerHTML = `<div class="mh">Message from ${esc(m.out ? "you" : m.sender?.name || "?")}</div>
    ${state.sending_enabled ? `<button class="mi" data-ma="reply">Reply${k("reply")}</button>
    <button class="mi" data-ma="react">Add reaction${k("react")}</button>
    <button class="mi" data-ma="forward">Forward${k("forward")}</button>
    <button class="mi" data-ma="save">Save to Saved Messages${k("save")}</button>
    <button class="mi" data-ma="pin">${m.pinned ? "Unpin" : "Pin"} message${k("pin")}</button>
    <button class="mi" data-ma="remind">Remind me about this${k("remind")}</button>` : ""}
    ${state.mark_read_enabled ? `<button class="mi" data-ma="unread">Mark unread${k("markAboveUnread")}</button>` : ""}
    ${m.link ? `<button class="mi" data-ma="link">Copy link</button>` : ""}
    ${m.out && state.sending_enabled ? `<div class="sep"></div><button class="mi" data-ma="edit">Edit message${k("edit")}</button>
    <button class="mi danger" data-ma="delete">Delete message…${k("delete")}</button>` : ""}`;
  menu.dataset.msg = m.id;
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(r.left - 160, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + "px";
}
$("#chat-feed").addEventListener("click", (e) => {
  const b = e.target.closest("[data-msgmenu]");
  if (!b) return;
  e.stopPropagation();
  const m = chatMessages.find((x) => x.id === Number(b.dataset.msgmenu));
  if (m) messageMenu(m, b);
});
$("#ctx-menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ma]");
  if (!b) return;
  e.stopImmediatePropagation();
  const m = chatMessages.find((x) => x.id === Number($("#ctx-menu").dataset.msg));
  closeMenu();
  if (!m) return;
  const anchor = rowOf(m.id);
  ({
    reply: () => setReply(m), react: () => reactPicker(m, anchor), forward: () => forwardMessage(m),
    save: () => api(`/api/chat/${currentChat}/save/${m.id}`, { method: "POST" }).then(() => toast("✓ Saved to <b>Saved Messages</b>"), (err) => toast(`Couldn't save: ${esc(err.message)}`, true)),
    pin: () => togglePin(m), remind: () => remindMe(m, anchor), unread: () => markUnread(currentChat),
    link: () => navigator.clipboard?.writeText(m.link).then(() => toast("Link copied")),
    edit: () => editMessage(m), delete: () => deleteMessage(m),
  })[b.dataset.ma]?.();
}, true);

// ---------------------------------------------------------------- upload (⌘O, or drop files on a chat)
const filePicker = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true });
document.body.appendChild(filePicker);
function uploadFile() {
  if (view !== "chat") return toast("Open a conversation first");
  if (!needWrites()) return;
  filePicker.value = "";
  filePicker.click();
}
filePicker.addEventListener("change", () => uploadFiles([...filePicker.files]));
async function uploadFiles(files) {
  const chatId = currentChat;
  const input = $("#chat-input");
  let caption = input.value.trim();
  for (const f of files) {
    toast(`Uploading <b>${esc(f.name)}</b>…`, false, 60000);
    try {
      const r = await fetch(`/api/chat/${chatId}/upload`, { method: "POST", body: await f.arrayBuffer(),
        headers: { ...GUARD, "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(f.name), "X-Caption": encodeURIComponent(caption), "X-Topic": String(currentTopic || "") } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      const { message } = await r.json();
      caption = "";
      setInput($("#chat-composer"), input, "");
      if (currentChat === chatId && view === "chat") {
        chatMessages.push(message);
        rerenderChat();
        $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
      }
      toast(`✓ Sent <b>${esc(f.name)}</b>`);
    } catch (e) { toast(`Not sent: ${esc(e.message)}`, true, 7000); }
  }
}
$("#view-chat").addEventListener("dragover", (e) => { if (state?.sending_enabled && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); $("#view-chat").classList.add("drop"); } });
$("#view-chat").addEventListener("dragleave", (e) => { if (!e.currentTarget.contains(e.relatedTarget)) $("#view-chat").classList.remove("drop"); });
$("#view-chat").addEventListener("drop", (e) => {
  $("#view-chat").classList.remove("drop");
  if (!e.dataTransfer?.files.length || !state?.sending_enabled) return;
  e.preventDefault();
  uploadFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------- snippet (⌘⇧↵) and canvas (⌘⇧N)
function makeSnippet(t) {
  const v = t.value.replace(/^```\n?|\n?```$/g, "");
  replaceRange(t, 0, t.value.length, "```\n" + v + "\n```", 4, 4 + v.length);
}
function newCanvas() {  // Telegram has no canvases: start a note in Saved Messages instead
  openSaved();
  setTimeout(() => {
    composeMode = state.sending_enabled ? "send" : "ask";
    updateComposer();
    const t = $("#chat-input");
    setInput($("#chat-composer"), t, "📝 ");
    t.focus();
    toast("New note in Saved Messages (Telegram's closest thing to a canvas)");
  }, 400);
}

// ---------------------------------------------------------------- status (⌘⇧Y): your Telegram bio
async function openStatus() {
  let about = "";
  try { about = (await api("/api/status")).about; } catch (e) { return toast(`Couldn't read your bio: ${esc(e.message)}`, true); }
  $("#details-title").textContent = "Set your status";
  $("#details-body").innerHTML = `<p class="modal-sub" style="padding:0 0 10px">Telegram has no Slack status, so this is your <b>bio</b>: everyone who opens your profile sees it.</p>
    <form id="status-form" class="composer" style="margin:0 0 12px"><textarea id="status-input" rows="2" maxlength="140" placeholder="What's your status?"></textarea>
    <div class="composer-bar"><span class="hint" id="status-count"></span><button type="submit" class="btn primary">Save</button></div></form>
    <div class="row-btns">${["🗓 In a meeting", "🚌 Commuting", "🤒 Out sick", "🌴 On vacation", "🏡 Working remotely"].map((s) => `<button class="btn" data-preset="${s}">${s}</button>`).join("")}<button class="btn" data-preset="">Clear</button></div>`;
  $("#details").hidden = false;
  const input = $("#status-input");
  input.value = about;
  const count = () => { $("#status-count").textContent = `${input.value.length}/70 (140 with Premium)`; };
  count();
  input.addEventListener("input", count);
  input.focus();
  $("#details-body").addEventListener("click", (e) => { const p = e.target.closest("[data-preset]"); if (p) { input.value = p.dataset.preset; count(); input.focus(); } });
  $("#status-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!needWrites()) return;
    try {
      await postJson("/api/status", { about: input.value.trim() });
      closeDetails();
      toast(input.value.trim() ? `✓ Status set: ${esc(input.value.trim())}` : "Status cleared");
    } catch (err) { toast(`Not saved: ${esc(err.message)}`, true); }
  });
}

// ---------------------------------------------------------------- huddle (⌘⇧H): Telegram voice chats
function startHuddle() {
  const c = view === "chat" ? chatById(currentChat) : null;
  if (!c) return toast("Open a conversation to start a voice chat");
  const url = c.username ? `https://t.me/${c.username}?${c.kind === "dm" ? "" : "videochat"}` : c.link && c.link.startsWith("http") ? c.link : `tg://openmessage?chat_id=${String(c.id).replace("-100", "")}`;
  window.open(url, "_blank", "noopener");
  toast(c.kind === "dm" ? "Opening the chat in Telegram to call from there" : "Opening the group's voice chat in Telegram");
}

// ---------------------------------------------------------------- folders as Slack workspaces (⌘⇧S, Ctrl+Tab, ⌘1…9)
let folderList = [{ id: 0, title: "All chats", emoji: "", chats: [] }];
let currentFolder = 0;
async function loadFolders() {
  try { folderList = (await api("/api/folders")).folders; } catch { /* keep All chats */ }
  currentFolder = store("folder") ?? 0;
  if (!folderList.some((f) => f.id === currentFolder)) currentFolder = 0;
  renderFolders();
}
function inFolder(c) {
  if (!currentFolder) return true;
  const f = folderList.find((x) => x.id === currentFolder);
  return !f || f.chats.includes(c.id);
}
function renderFolders() {
  const rail = $("#folder-rail");
  rail.innerHTML = folderList.map((f, i) => `<button class="folder-tile ${f.id === currentFolder ? "active" : ""}" data-folder="${f.id}"
    title="${esc(f.title)}${i < 9 ? ` (${plainCombo("Mod+" + (i + 1))})` : ""}">${esc(f.emoji || initials(f.title))}</button>`).join("");
  const f = folderList.find((x) => x.id === currentFolder);
  $(".ws-menu h2").innerHTML = `${esc(currentFolder ? f?.title || "AhaSlack" : "AhaSlack")} <span class="caret-dn">⌄</span>`;
}
function selectFolder(id) {
  if (!folderList.some((f) => f.id === id)) return;
  currentFolder = id;
  store("folder", id);
  renderFolders();
  renderSidebar();
  const f = folderList.find((x) => x.id === id);
  toast(`Folder: <b>${esc(f.title)}</b>`, false, 1800);
}
function stepFolder(dir) {
  const i = folderList.findIndex((f) => f.id === currentFolder);
  selectFolder(folderList[(i + dir + folderList.length) % folderList.length].id);
}
function folderByNumber(n) { const f = folderList[n - 1]; if (f) selectFolder(f.id); }
function toggleFolderSwitcher() { $(".rail").classList.toggle("folders-open"); }
$("#folder-rail").addEventListener("click", (e) => { const b = e.target.closest("[data-folder]"); if (b) selectFolder(Number(b.dataset.folder)); });

// ---------------------------------------------------------------- More (Ctrl+0) and Files (⌘⇧J)
function openMore() {
  setView("more");
  header(`<span class="hash">⋯</span><h1>More</h1><span class="topic">Everything else in this app</span>`);
  const tile = (icon, title, sub, act) => `<button class="more-tile" data-more-act="${act}"><span class="ico">${icon}</span><span><b>${title}</b><span class="sub">${sub}</span></span></button>`;
  $("#more-feed").innerHTML = `<div class="more-grid">
    ${tile("🗂", "Files", "Pictures this app downloaded · " + plainCombo("Mod+Shift+J"), "files")}
    ${tile("🔖", "Saved Messages", "Your saved items and notes", "saved")}
    ${tile("≡", "All unreads", plainCombo("Mod+Shift+A"), "unreads")}
    ${tile("@", "Activity", "Mentions & replies · " + plainCombo("Mod+Shift+M"), "mentions")}
    ${tile("✦", "Inbox Manager", "Ask about your Telegram", "manager")}
    ${tile("📁", "Folders", `${folderList.length - 1} Telegram folders · ${plainCombo("Mod+Shift+S")}`, "folders")}
    ${tile("💬", "Status", "Your Telegram bio · " + plainCombo("Mod+Shift+Y"), "status")}
    ${tile("⌨", "Preferences & shortcuts", plainCombo("Mod+,"), "prefs")}
  </div>`;
}
$("#more-feed")?.addEventListener("click", (e) => {
  const a = e.target.closest("[data-more-act]")?.dataset.moreAct;
  ({ files: openFiles, saved: openSaved, unreads: () => navigate({ view: "unreads" }), mentions: () => navigate({ view: "mentions" }),
    manager: () => navigate({ view: "manager" }), folders: toggleFolderSwitcher, status: openStatus, prefs: openShortcuts })[a]?.();
});
async function openFiles() {
  setView("files");
  header(`<span class="hash">🗂</span><h1>Files</h1><span class="topic">Pictures this app has downloaded</span>`);
  const feed = $("#files-feed");
  feed.innerHTML = `<div class="loading">Loading…</div>`;
  let items = [];
  try { items = (await api("/api/downloads")).items; } catch (e) { feed.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
  if (!items.length) { feed.innerHTML = `<div class="empty">Nothing downloaded yet. Pictures you open in chats show up here.</div>`; return; }
  feed.innerHTML = `<div class="file-grid">${items.map((f) => `<button class="file-card" data-chat="${f.chat_id}" data-msg="${f.msg_id}">
    <img loading="lazy" alt="" src="${esc(f.url)}"><span class="nm">${esc(f.chat)}</span><span class="sub">${esc(ago(f.ts))} · ${Math.max(1, Math.round(f.size / 1024))} KB</span></button>`).join("")}</div>`;
}
$("#files-feed")?.addEventListener("click", (e) => {
  const b = e.target.closest(".file-card");
  if (b) navigate({ view: "chat", chatId: Number(b.dataset.chat), focus: Number(b.dataset.msg) });
});

loadFolders();
