"use strict";
// Thread accuracy check: ~100 grouping decisions from your busiest groups, one at a time. You say
// whether the rule got it right (Y) or wrong (N), or skip (S). Results are counted per rule and
// saved on your Mac (inbox.db), where they also become training data for a future model.
// Read-only on Telegram: it only loads recent messages.

const RULES_VERSION = "v2";
const CHECK_KINDS = {
  reply:  { label: "Reply link",     q: "Does this message belong in this thread?",                         rule: "It used Telegram's Reply on a message in this thread." },
  split:  { label: "Late reply",     q: "Right to start a new thread here instead of joining the old one?", rule: "It replies to a message more than 2 hours older, so it was shown as a new thread." },
  burst:  { label: "Follow-up",      q: "Does this message belong in this thread?",                         rule: "Guess: the same person wrote it within a minute of their reply in this thread." },
  answer: { label: "Short answer",   q: "Does this message belong in this thread?",                         rule: "Guess: a short answer right after a message in this thread." },
  revive: { label: "Old reply",      q: "Right to keep it in the channel?",                                 rule: "It replies to an old message that isn't loaded, so it stayed in the channel." },
  missed: { label: "Left out",       q: "Right to leave it in the channel (not in the thread above)?",     rule: "Sent right after a thread message without Reply, and no rule put it in the thread." },
};
const PER_KIND = { reply: 25, split: 15, burst: 20, answer: 15, revive: 5, missed: 25 };
let check = null;  // {cards, i, results: [{card, verdict}], population: {kind: count}, saved}

function openThreadCheck() {
  setView("threadcheck");
  header(`<span class="hash">✓</span><h1>Thread accuracy check</h1><span class="topic">Is each grouping right? Y yes · N no · S skip</span>`,
    `<button class="btn" data-act="tc-restart">↻ <span class="lbl">New sample</span></button>`);
  if (check && check.i < check.cards.length) return renderCheck();
  startCheck();
}
async function startCheck() {
  const feed = $("#threadcheck-feed");
  feed.innerHTML = `<div class="loading">Picking your busiest groups…</div>`;
  let prior = { labeled: [] };
  try { prior = await api("/api/thread-labels"); } catch { /* fine */ }
  const done = new Set(prior.labeled);
  const groups = (state?.chats || []).filter((c) => c.kind === "group" && !c.muted && !c.ignored)
    .sort((a, b) => b.last_ts - a.last_ts).slice(0, 12);
  const pools = Object.fromEntries(Object.keys(CHECK_KINDS).map((k) => [k, []]));
  const population = Object.fromEntries(Object.keys(CHECK_KINDS).map((k) => [k, 0]));
  // load 4 groups at a time
  let loaded = 0;
  const windows = new Map();
  const queue = [...groups];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try { windows.set(c.id, (await api(`/api/chat/${c.id}?limit=200`)).messages); } catch { /* skip that group */ }
      feed.innerHTML = `<div class="loading">Reading your groups… ${++loaded} of ${groups.length}</div>`;
    }
  }));
  for (const c of groups) {
    const msgs = windows.get(c.id);
    if (!msgs) continue;
    const T = buildThreadsWith(msgs, { overrides: threadOverride, guesses: true });
    const byId = new Map(msgs.map((m) => [m.id, m]));
    msgs.forEach((m, i) => {
      let kind = null;
      const v = T.via.get(m.id);
      if (T.splitAt.has(m.id)) kind = "split";
      else if (v === "revive") kind = "revive";
      else if (T.rootOf.has(m.id) && ["reply", "burst", "answer"].includes(v)) kind = v;
      else if (!T.rootOf.has(m.id) && !m.reply_to && i > 0 && T.rootOf.has(msgs[i - 1].id) && tsOf(m) - tsOf(msgs[i - 1]) <= 300) kind = "missed";
      if (!kind) return;
      population[kind]++;
      if (done.has(`${c.id}:${m.id}:${kind}`)) return;
      const rootId = kind === "missed" ? T.rootOf.get(msgs[i - 1].id) : kind === "split" ? m.reply_to : T.rootOf.get(m.id);
      const thread = rootId != null ? (T.threads.get(rootId)?.replies || []).filter((x) => x.id < m.id).slice(-2) : [];
      pools[kind].push({ chat: c, kind, m, rootId, root: rootId != null ? byId.get(rootId) || null : null, thread,
        before: msgs.slice(Math.max(0, i - 2), i).filter((x) => !thread.includes(x) && x.id !== rootId) });
    });
  }
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const cards = shuffle(Object.entries(pools).flatMap(([k, list]) => shuffle(list).slice(0, PER_KIND[k])));
  check = { cards, i: 0, results: [], population, saved: 0 };
  if (!cards.length) { feed.innerHTML = `<div class="empty">Nothing new to check in your recent group messages.</div>`; return; }
  renderCheck();
}

function renderCheck() {
  const feed = $("#threadcheck-feed");
  if (check.i >= check.cards.length) return renderCheckResults();
  const c = check.cards[check.i], K = CHECK_KINDS[c.kind];
  const pct = Math.round((check.i / check.cards.length) * 100);
  const row = (m, cls = "") => msgRow(m, null, { cls });
  const threadPart = c.root || c.thread.length ? `<div class="tc-label">${c.kind === "split" ? "The older message it replies to" : "The thread"}</div>
      <div class="tc-thread">${c.root ? row(c.root, "tc-root") : `<div class="sub" style="padding:6px 16px">The first message isn't loaded.</div>`}
      ${c.thread.map((x) => row(x)).join("")}</div>` : "";
  feed.innerHTML = `<div class="tc-wrap">
    <div class="tc-progress"><div style="width:${pct}%"></div></div>
    <div class="tc-meta"><b>${check.i + 1}</b> of ${check.cards.length} · ${esc(chatLabel(c.chat))} · <span class="tc-kind">${esc(K.label)}</span></div>
    ${threadPart}
    ${c.before.length ? `<div class="tc-label">Just before, in the channel</div>${c.before.map((x) => row(x, "tc-dim")).join("")}` : ""}
    <div class="tc-label">The message</div>${row(c.m, "tc-focus")}
    <div class="tc-ask">
    <div class="tc-rule">${esc(K.rule)}</div>
    <div class="tc-q">${esc(K.q)}</div>
    <div class="tc-buttons">
      <button class="btn tc-yes" data-verdict="1">✓ Yes <kbd>Y</kbd></button>
      <button class="btn tc-no" data-verdict="0">✗ No <kbd>N</kbd></button>
      <button class="btn" data-verdict="skip">Skip <kbd>S</kbd></button>
      ${check.i ? `<button class="btn" data-verdict="back">← Back</button>` : ""}
      <span class="sp"></span><button class="btn" data-verdict="finish">Show results</button>
    </div></div></div>`;
  feed.scrollTop = 0;
  for (const t of $$(".tc-thread .tg-text, .tc-dim .tg-text", feed)) if (t.scrollHeight > 130) t.classList.add("clamped");
  const focus = $(".tc-focus", feed);  // keep the message being judged in view
  if (focus && focus.getBoundingClientRect().bottom > window.innerHeight - 180) focus.scrollIntoView({ block: "center" });
}
async function answerCheck(v) {
  if (!check || view !== "threadcheck") return;
  if (v === "finish") { await saveCheck(); return renderCheckResults(); }
  if (v === "back") { if (check.i > 0) { check.i--; check.results = check.results.filter((r) => r.card !== check.cards[check.i]); } return renderCheck(); }
  const card = check.cards[check.i];
  if (v !== "skip") check.results.push({ card, verdict: v === "1" });
  check.i++;
  if (check.results.length - check.saved >= 10) saveCheck();
  renderCheck();
}
async function saveCheck() {
  const fresh = check.results.slice(check.saved);
  if (!fresh.length) return;
  check.saved = check.results.length;
  const items = fresh.map(({ card: c, verdict }) => ({
    chat_id: c.chat.id, msg_id: c.m.id, kind: c.kind, root_id: c.rootId ?? null, verdict, rules: RULES_VERSION,
    data: { text: (c.m.text || c.m.media || "").slice(0, 500), root: (c.root?.text || "").slice(0, 300),
      thread: c.thread.map((x) => (x.text || x.media || "").slice(0, 200)), before: c.before.map((x) => (x.text || x.media || "").slice(0, 200)),
      gap: c.thread.length ? Math.round(tsOf(c.m) - tsOf(c.thread[c.thread.length - 1])) : null },
  }));
  try { await postJson("/api/thread-labels", { items }); } catch (e) { check.saved -= fresh.length; toast(`Couldn't save: ${esc(e.message)}`, true); }
}

async function renderCheckResults() {
  const feed = $("#threadcheck-feed");
  let sum = {};
  try { sum = (await api(`/api/thread-labels?rules=${RULES_VERSION}`)).summary; } catch { /* fall back to this session */ }
  for (const r of check?.results.slice(check.saved) || []) {  // not saved yet
    const s = (sum[r.card.kind] ||= { n: 0, ok: 0 }); s.n++; s.ok += r.verdict ? 1 : 0;
  }
  const pop = check?.population || {};
  let wsum = 0, wacc = 0;
  const rows = Object.entries(CHECK_KINDS).map(([k, K]) => {
    const s = sum[k] || { n: 0, ok: 0 };
    const acc = s.n ? s.ok / s.n : null;
    if (acc != null && pop[k]) { wsum += pop[k]; wacc += pop[k] * acc; }
    return `<tr><td>${esc(K.label)}</td><td class="num">${pop[k] ?? "–"}</td><td class="num">${s.n}</td>
      <td class="num">${acc == null ? "–" : `<b class="${acc >= 0.85 ? "good" : acc >= 0.7 ? "ok" : "bad"}">${Math.round(acc * 100)}%</b>`}</td></tr>`;
  }).join("");
  const overall = wsum ? Math.round((wacc / wsum) * 100) : null;
  const total = Object.values(sum).reduce((a, s) => a + s.n, 0);
  feed.innerHTML = `<div class="tc-wrap">
    <h2 class="tc-big">${overall == null ? "Not enough answers yet" : total < 30 ? `Early estimate: about ${overall}% right` : `About ${overall}% right`}</h2>
    ${total < 30 ? `<p class="sub"><b>Only ${total} answer${total === 1 ? "" : "s"} so far.</b> The number gets reliable after about 30, and once every rule has a few.</p>` : ""}
    <p class="sub">${total} decision${total === 1 ? "" : "s"} checked with rules ${RULES_VERSION}. The overall number weights each rule by how often it fires in your recent messages, so it's comparable to your earlier ~70% estimate.</p>
    <table class="tc-table"><thead><tr><th>Rule</th><th class="num">How often (last 200 msgs × ${Math.min(12, (state?.chats || []).length)} groups)</th><th class="num">You checked</th><th class="num">Right</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="sub">Your answers are saved on this Mac and become training data for a future model. Rules below ~70% are the ones to fix next.</p>
    <div class="tc-buttons">${check && check.i < check.cards.length ? `<button class="btn primary" data-verdict="continue">Keep checking (${check.cards.length - check.i} left)</button>` : ""}
      <button class="btn" data-act-tc="restart">Check a new sample</button></div></div>`;
}

$("#threadcheck-feed").addEventListener("click", (e) => {
  const cl = e.target.closest(".tg-text.clamped");
  if (cl) { cl.classList.remove("clamped"); return; }
  const b = e.target.closest("[data-verdict]");
  if (b) return b.dataset.verdict === "continue" ? renderCheck() : answerCheck(b.dataset.verdict);
  if (e.target.closest('[data-act-tc="restart"]')) { check = null; startCheck(); }
});
$("#ch-actions").addEventListener("click", (e) => { if (e.target.closest('[data-act="tc-restart"]')) { check = null; startCheck(); } });
window.addEventListener("keydown", (e) => {  // before the app's own shortcuts
  if (view !== "threadcheck" || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || overlayOpen()) return;
  const k = e.key.toLowerCase();
  const v = { y: "1", n: "0", s: "skip", arrowleft: "back" }[k];
  if (!v || !check || check.i >= check.cards.length) return;
  e.preventDefault();
  e.stopPropagation();
  answerCheck(v);
}, true);
