"use strict";
// Emoji, custom emoji, stickers and gifts from your Telegram, in a picker by the message box.
// Unicode emoji use emoji-picker-element; custom emoji, stickers and gifts come from /api.
// Stickers send on click like Telegram; gifts are view-only (they cost Stars).

let pickerLib = null;          // /api/stickers
const pickerSets = {};         // set id -> stickers
let pickerTab = "emoji";

// ---------------------------------------------------------------- sticker tiles (static, Lottie, video)
function stickerTile(doc, { thumb = true, cls = "", attrs = "" } = {}) {
  if (!doc) return `<span class="stk-tile empty ${cls}"></span>`;
  const src = `/api/sticker/${doc.id}`;
  let inner;
  if (thumb && doc.has_thumb) inner = `<img loading="lazy" alt="${esc(doc.emoji)}" src="${src}?thumb=1">`;
  else if (doc.format === "animated") inner = `<div class="lottie" data-lottie="${src}"></div>`;
  else if (doc.format === "video") inner = `<video src="${src}" autoplay loop muted playsinline></video>`;
  else inner = `<img loading="lazy" alt="${esc(doc.emoji)}" src="${src}">`;
  return `<button type="button" class="stk-tile ${cls}" data-doc="${doc.id}" title="${esc(doc.emoji)}" ${attrs}>${inner}</button>`;
}
// Animated stickers and custom emoji: start Lottie when they scroll into view, pause when out.
const lottieIO = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const en of entries) {
    const el = en.target;
    if (en.isIntersecting && !el._anim && window.lottie) {
      el._anim = lottie.loadAnimation({ container: el, renderer: "svg", loop: true, autoplay: true, path: el.dataset.lottie });
    } else if (el._anim) {
      en.isIntersecting ? el._anim.play() : el._anim.pause();
    }
  }
}, { rootMargin: "100px" }) : null;
new MutationObserver(() => {
  for (const el of document.querySelectorAll(".lottie[data-lottie]:not([data-watch])")) {
    el.dataset.watch = "1";
    lottieIO?.observe(el);
  }
}).observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------- the panel
function ensurePicker() {
  if ($("#picker")) return $("#picker");
  $("#chat-composer").insertAdjacentHTML("beforebegin", `<div class="picker" id="picker" hidden>
    <div class="picker-tabs">
      <button data-ptab="emoji">😀 Emoji</button><button data-ptab="custom">✨ Custom emoji</button>
      <button data-ptab="stickers">🗂 Stickers</button><button data-ptab="gifts">🎁 Gifts</button>
      <span class="sp"></span><button data-pclose title="Close (Esc)">✕</button>
    </div>
    <div class="picker-body" id="picker-body"></div></div>`);
  const p = $("#picker");
  p.addEventListener("click", onPickerClick);
  return p;
}
function openPicker(tab = pickerTab) {
  if (view !== "chat") return toast("Open a conversation first");
  const p = ensurePicker();
  p.hidden = false;
  showPickerTab(tab);
}
function closePicker() { const p = $("#picker"); if (p) p.hidden = true; }
function togglePicker() { ($("#picker") && !$("#picker").hidden) ? closePicker() : openPicker(); }

async function showPickerTab(tab) {
  pickerTab = tab;
  $$("#picker [data-ptab]").forEach((b) => b.classList.toggle("on", b.dataset.ptab === tab));
  const body = $("#picker-body");
  if (tab === "emoji") {
    body.innerHTML = `<emoji-picker class="${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}"></emoji-picker>`;
    $("emoji-picker", body).addEventListener("emoji-click", (e) => insertIntoComposer(e.detail.unicode));
    return;
  }
  if (tab === "gifts") return showGifts(body);
  body.innerHTML = `<div class="loading">Loading your ${tab === "custom" ? "custom emoji" : "stickers"}…</div>`;
  try { pickerLib = pickerLib || await api("/api/stickers"); } catch (e) { body.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
  if (tab === "stickers") {
    const row = (title, docs) => docs.length ? `<div class="pk-head">${esc(title)}</div><div class="stk-grid">${docs.map((d) => stickerTile(d, { attrs: 'data-send="1"' })).join("")}</div>` : "";
    body.innerHTML = row("Recently used", pickerLib.recent) + row("Favorites", pickerLib.faved) +
      `<div class="pk-head">Your sticker sets · ${pickerLib.sets.length}</div>` +
      pickerLib.sets.map((s) => `<details class="pk-set" data-set="${s.id}" data-hash="${s.access_hash}"><summary>${esc(s.title)} <span class="sub">${s.count}</span></summary><div class="stk-grid"></div></details>`).join("") ||
      `<div class="empty">No stickers yet.</div>`;
  } else {
    body.innerHTML = `<div class="pk-note">Custom emoji show as animated emoji for Telegram Premium users; others see the plain emoji.</div>` +
      (pickerLib.emoji_sets.map((s) => `<details class="pk-set" data-set="${s.id}" data-hash="${s.access_hash}" data-custom="1"><summary>${esc(s.title)} <span class="sub">${s.count}</span></summary><div class="stk-grid small"></div></details>`).join("") ||
        `<div class="empty">You haven't added any custom emoji sets.</div>`);
  }
  for (const d of $$("details.pk-set", body)) d.addEventListener("toggle", () => d.open && loadSet(d));
  const first = $("details.pk-set", body);
  if (first && tab === "custom") { first.open = true; }
}
async function loadSet(d) {
  const grid = $(".stk-grid", d);
  if (grid.dataset.loaded) return;
  grid.dataset.loaded = "1";
  grid.innerHTML = `<span class="sub">Loading…</span>`;
  try {
    const docs = pickerSets[d.dataset.set] || (pickerSets[d.dataset.set] = (await api(`/api/stickers/set/${d.dataset.set}/${d.dataset.hash}`)).stickers);
    grid.innerHTML = docs.map((doc) => stickerTile(doc, { attrs: d.dataset.custom ? `data-emoji="${esc(doc.emoji)}"` : 'data-send="1"' })).join("");
  } catch (e) { grid.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

async function onPickerClick(e) {
  if (e.target.closest("[data-pclose]")) return closePicker();
  const tab = e.target.closest("[data-ptab]");
  if (tab) return showPickerTab(tab.dataset.ptab);
  const tile = e.target.closest(".stk-tile[data-doc]");
  if (!tile) return;
  if (tile.dataset.emoji !== undefined) return insertIntoComposer(`[${tile.dataset.emoji || "⭐"}](emoji/${tile.dataset.doc})`);
  if (tile.dataset.send) return sendSticker(tile.dataset.doc);
  if (tile.dataset.gift !== undefined) return;
}
function insertIntoComposer(text) {
  const t = $("#chat-input");
  t.focus();
  if (!document.execCommand("insertText", false, text)) t.setRangeText(text, t.selectionStart, t.selectionEnd, "end");
  t.dispatchEvent(new Event("input"));
}
async function sendSticker(docId) {
  if (!needWrites()) return;
  const chatId = currentChat;
  closePicker();
  try {
    const { message } = await postJson(`/api/chat/${chatId}/sticker`, { doc_id: docId });
    lastSent = { chatId, msgId: message.id, at: Date.now() };
    if (view === "chat" && currentChat === chatId && !chatMessages.some((m) => m.id === message.id)) {
      chatMessages.push(message);
      rerenderChat();
      $("#chat-feed").scrollTop = $("#chat-feed").scrollHeight;
    }
  } catch (err) { toast(`Sticker not sent: ${esc(err.message)}`, true); }
}

// ---------------------------------------------------------------- gifts (view only)
async function showGifts(body) {
  body.innerHTML = `<div class="loading">Loading your gifts…</div>`;
  let g;
  try { g = await api("/api/gifts"); } catch (e) { body.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
  const c = chatById(currentChat);
  const tile = (x, extra) => `<div class="gift">${stickerTile(x.doc, { thumb: false, attrs: "data-gift" })}${extra}</div>`;
  body.innerHTML = `<div class="pk-note">Gifts cost Telegram Stars, so this app only shows them. ${c?.link?.startsWith("http") ? `<a class="ext" href="${esc(c.link)}" target="_blank" rel="noopener">Send a gift to ${esc(c.name)} in Telegram ↗</a>` : "Send gifts from the Telegram app."}</div>
    <div class="pk-head">On your profile · ${g.count}</div>
    <div class="gift-grid">${g.mine.map((x) => tile(x, `<b>${esc(x.title)}</b><span class="sub">${x.from ? "from " + esc(x.from) : ""}${x.stars ? ` · ⭐ ${x.stars}` : ""}</span>`)).join("") || `<span class="sub">No gifts on your profile yet.</span>`}</div>
    <div class="pk-head">Gift catalog · ${g.catalog.length}</div>
    <div class="gift-grid">${g.catalog.map((x) => tile(x, `<b>⭐ ${x.stars}</b><span class="sub">${x.sold_out ? "sold out" : x.limited ? `${x.remains ?? "?"}/${x.total ?? "?"} left` : ""}</span>`)).join("")}</div>`;
}

// ---------------------------------------------------------------- wiring: composer button, Esc, shortcut
(function addPickerButton() {
  const bar = $("#chat-composer .composer-bar");
  bar.insertAdjacentHTML("afterbegin", `<button type="button" class="pk-btn" id="picker-btn" title="Emoji, stickers and gifts (⌘⇧E… or click)">☺</button>`);
  $("#picker-btn").addEventListener("click", togglePicker);
})();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#picker") && !$("#picker").hidden) { e.stopPropagation(); closePicker(); }
}, true);
ACTIONS.push({ group: "This app (not in Slack)", id: "picker", label: "Emoji, custom emoji, stickers and gifts", def: "Mod+Alt+E", alt: [], when: "any", run: () => togglePicker() });
