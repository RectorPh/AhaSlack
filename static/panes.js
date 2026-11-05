"use strict";
// Two Slack touches: drag the right pane's edge to resize it (thread / Inbox Manager), and
// right-click a reaction (or hover it) to see who reacted.

// ---------------------------------------------------------------- resizable right pane
const PANE_MIN = 300, PANE_DEFAULT = 400;
const paneMax = () => Math.max(PANE_MIN, Math.min(900, window.innerWidth * 0.65));
function setPaneWidth(w, save = false) {
  w = Math.round(Math.max(PANE_MIN, Math.min(paneMax(), w)));
  $("#pane").style.setProperty("--pane-w", w + "px");
  if (save) store("paneWidth", w);
}
(function paneResizer() {
  const pane = $("#pane");
  pane.insertAdjacentHTML("afterbegin", `<div class="pane-resizer" id="pane-resizer" title="Drag to resize · double-click to reset"></div>`);
  const handle = $("#pane-resizer");
  const saved = Number(store("paneWidth"));
  if (saved) setPaneWidth(saved);
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    document.body.classList.add("resizing-pane");
    const move = (ev) => setPaneWidth(startW + (startX - ev.clientX));
    const up = () => {
      document.body.classList.remove("resizing-pane");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setPaneWidth(pane.getBoundingClientRect().width, true);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  handle.addEventListener("dblclick", () => setPaneWidth(PANE_DEFAULT, true));
  window.addEventListener("resize", () => { const w = pane.getBoundingClientRect().width; if (w > paneMax()) setPaneWidth(paneMax()); });
})();

// ---------------------------------------------------------------- who reacted
const reactorsCache = new Map();  // "chat:msg" -> {at, people}
async function reactorsOf(chatId, msgId) {
  const key = `${chatId}:${msgId}`;
  const hit = reactorsCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.people;
  const { people } = await api(`/api/chat/${chatId}/msg/${msgId}/reactions`);
  reactorsCache.set(key, { at: Date.now(), people });
  return people;
}
function chipTarget(chip) {
  const chatId = Number(chip.dataset.chat) || currentChat;
  const msgId = Number(chip.dataset.msg || chip.closest(".msg")?.dataset.id);
  return chatId && msgId ? { chatId, msgId } : null;
}
const nameList = (ps) => {
  const n = ps.map((p) => (p.me ? "You" : p.name));
  return n.length <= 3 ? n.join(", ").replace(/, ([^,]*)$/, " and $1") : `${n.slice(0, 3).join(", ")} and ${n.length - 3} others`;
};

document.addEventListener("contextmenu", async (e) => {
  const chip = e.target.closest(".react-chip");
  if (!chip) return;
  e.preventDefault();
  e.stopPropagation();
  const t = chipTarget(chip);
  if (!t) return;
  const menu = $("#ctx-menu");
  delete menu.dataset.react;
  menu.innerHTML = `<div class="mh">Reactions</div><div class="reactors"><div class="sub" style="padding:4px 16px">Loading…</div></div>`;
  menu.hidden = false;
  const place = () => {
    const r = chip.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
    const below = r.bottom + 6;
    menu.style.top = (below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 6) : below) + "px";
  };
  place();
  let people;
  try { people = await reactorsOf(t.chatId, t.msgId); }
  catch (err) { $(".reactors", menu).innerHTML = `<div class="sub" style="padding:4px 16px;max-width:280px;white-space:normal">${esc(err.message)}</div>`; return place(); }
  const groups = new Map();
  for (const p of people) { if (!groups.has(p.emoji)) groups.set(p.emoji, []); groups.get(p.emoji).push(p); }
  const first = chip.dataset.emo;  // the one you right-clicked first
  const order = [...groups.keys()].sort((a, b) => (b === first) - (a === first));
  $(".reactors", menu).innerHTML = order.map((emo) => `<div class="rx-head"><span class="rx-emo">${esc(emo)}</span> ${groups.get(emo).length}</div>` +
    groups.get(emo).map((p) => `<div class="rx-row">${av(p, "s20")}<span>${esc(p.name)}${p.me ? " <span class='sub'>(you)</span>" : ""}</span></div>`).join("")).join("")
    || `<div class="sub" style="padding:4px 16px">No one yet.</div>`;
  place();
}, true);

// Hover a reaction for a moment: "Linh, Marco and You reacted with 👍", like Slack's tooltip.
let rxHoverTimer = null;
document.addEventListener("mouseover", (e) => {
  const chip = e.target.closest?.(".react-chip");
  if (!chip || chip.dataset.who) return;
  clearTimeout(rxHoverTimer);
  rxHoverTimer = setTimeout(async () => {
    const t = chipTarget(chip);
    if (!t || !chip.matches(":hover")) return;
    try {
      const ps = (await reactorsOf(t.chatId, t.msgId)).filter((p) => p.emoji === chip.dataset.emo);
      if (ps.length) { chip.dataset.who = "1"; chip.title = `${nameList(ps)} reacted with ${chip.dataset.emo} · right-click for the list`; }
    } catch { /* private list: keep the default tooltip */ }
  }, 450);
});
