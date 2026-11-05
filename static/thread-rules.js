"use strict";
// Which Slack-style thread each Telegram message belongs to. Telegram has no real threads: only
// "Reply" links, and many people answer without pressing Reply.
//
// Default ("classic", the original rules, which read better in practice):
//   0. ai        the local AI's answer from the server (thread_hint: a root id, or 0 = not in a thread)
//   1. manual    your own corrections (⇱) always win
//   2. reply     a Reply joins the thread of the message it answers (Telegram's own chain)
//   3. burst     the same person's next message within 2 minutes of their thread reply (AUTO),
//                unless the local AI said it isn't part of the thread
//
// The stricter "v2" rules below (split late replies, revive old ones, tighter burst, short
// answers) are kept for comparison (rules: "v2"); they measured as less natural, so they're off.
//
//   0. hint      certain  a classifier's answer from the server (thread_hint), when there is one
//   1. manual    certain  your own corrections (⇱ "not part of this thread") always win
//   2. reply     certain  a Reply joins the thread of the message it answers, except:
//        · split    a reply that comes more than 2 hours after the message it answers starts a new
//                   thread (the conversation resumed; it isn't buried in a stale one)
//        · revive   a reply to an old message that isn't loaded, with nothing else in that thread
//                   loaded, stays in the channel (someone bringing an old message back up)
//   3. burst     guess    the same person's next message within 60 s of their thread reply, when it
//                   isn't addressed to the group ("mọi người…", "@all", @someone outside the thread,
//                   a long announcement)
//   4. answer    guess    a short answer ("ok", "dạ", "đúng rồi", 👍…) right after a thread message,
//                   from someone in that thread or tagged in it, within 3 minutes
// Guesses (3, 4) can be turned off (uiPrefs.threadGuess = false).
// Pure function: also runs in Node (tests and the accuracy check use it).

const THREAD_RULES = {
  SPLIT_GAP_S: 2 * 3600,
  BURST_S: 60,
  ANSWER_S: 180,
  LONG_TEXT: 300,
  TO_GROUP: /^\s*(@all\b|mọi người|moi nguoi|mn\b|ae\b|anh em|anh chị|anh chi|cả nhà|ca nha|các bạn|cac ban|team\b|hi all|hello all|hi team|dear all|dear team|all\b)/iu,
  ANSWER: /^\s*(ok(e|ie|ay)?|oki|okela|dạ+|da+|vâng|vang|ừ+|uh+|um+|đúng rồi|dung roi|đúng|chuẩn|chuan|được|duoc|đc|dc|rõ|ro|nhận|noted|got it|thanks?|thank you|tks|thx|ty|cảm ơn|cam on|cám ơn|yes|yep|no|không|ko|k|chưa|rồi|roi|xong|done)(?=$|[\s!.,…?])[\s!.,…a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]{0,20}$/i,
  EMOJI_ONLY: /^[\s\p{Extended_Pictographic}‍️]+$/u,
  // words that address the whole group wherever they appear ("vô xem thời sự mn", "check giúp ae")
  GROUP_WORDS: /(^|[\s,.!?(])(@all|mọi người|moi nguoi|mn|ae|anh em|cả nhà|ca nha|các bạn|cac ban|everyone|everybody)(?=$|[\s,.!?)])/iu,
};

function tsOf(m) {
  if (typeof m.ts === "number") return m.ts;
  const d = Date.parse(String(m.date || "").replace(" ", "T") + ":00");  // older servers: minutes only
  return Number.isNaN(d) ? 0 : d / 1000;
}
const senderKey = (m) => (m.out ? "me" : String(m.sender?.peer ?? m.sender?.id ?? m.sender?.name ?? "?"));

function buildThreadsWith(msgs, { overrides = () => undefined, guesses = true, rules = "classic" } = {}) {
  const R = THREAD_RULES;
  const v2 = rules === "v2";
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const rootOf = new Map();  // message id -> thread root id (only for messages inside a thread)
  const via = new Map();     // message id -> rule name
  const splitAt = new Set(); // replies that start their own thread (rule 2 split)

  // Rule 2, the reply chain, climbing to the root.
  const resolve = (m, depth = 0) => {
    if (rootOf.has(m.id)) return rootOf.get(m.id);
    if (splitAt.has(m.id) || depth > 60) return null;
    let r = null;
    if (m.thread_hint && !m.reply_to) { r = m.thread_hint; via.set(m.id, "ai"); }
    else if (m.reply_to) {
      const parent = byId.get(m.reply_to);
      if (parent) {
        if (v2 && tsOf(m) - tsOf(parent) > R.SPLIT_GAP_S) { splitAt.add(m.id); return null; }  // resumed later: new thread
        r = resolve(parent, depth + 1) ?? parent.id;
      } else {
        r = m.thread_top || m.reply_to;  // the start isn't loaded
      }
      via.set(m.id, "reply");
    }
    if (r != null && r !== m.id) rootOf.set(m.id, r);
    return rootOf.get(m.id) ?? null;
  };
  for (const m of msgs) resolve(m);

  // Rule 2, revive: a lone reply to something old and unloaded stays in the channel.
  const orphanCount = new Map();
  for (const [id, r] of rootOf) if (!byId.has(r)) orphanCount.set(r, (orphanCount.get(r) || 0) + 1);
  for (const [id, r] of v2 ? [...rootOf] : []) {
    if (!byId.has(r) && orphanCount.get(r) === 1 && via.get(id) === "reply") { rootOf.delete(id); via.set(id, "revive"); }
  }

  // Who is in each thread (root author, everyone who replied), for rules 3 and 4.
  const members = new Map();
  const addMember = (root, m) => { if (!members.has(root)) members.set(root, new Set()); members.get(root).add(senderKey(m)); };
  for (const [id, r] of rootOf) { addMember(r, byId.get(id)); if (byId.has(r)) addMember(r, byId.get(r)); }

  // Rules 1, 3, 4, in message order.
  let prev = null;
  for (const m of msgs) {
    const ov = overrides(m);
    if (ov === 0) { rootOf.delete(m.id); via.set(m.id, "manual"); prev = m; continue; }
    if (ov) { rootOf.set(m.id, ov); via.set(m.id, "manual"); prev = m; continue; }
    if (m.thread_hint === 0) { via.set(m.id, "ai-none"); prev = m; continue; }  // the local AI said: not a thread reply
    if (!v2 && guesses && !rootOf.has(m.id) && !m.reply_to && prev && rootOf.has(prev.id) && senderKey(prev) === senderKey(m) &&
        tsOf(m) - tsOf(prev) <= 120) {
      rootOf.set(m.id, rootOf.get(prev.id)); via.set(m.id, "burst");                      // classic rule 3
    } else if (v2 && guesses && !rootOf.has(m.id) && !m.reply_to && prev && rootOf.has(prev.id) && !(m.reply_count > 0)) {
      const root = rootOf.get(prev.id);
      const gap = tsOf(m) - tsOf(prev);
      const text = (m.text || "").trim();
      const inThread = members.get(root) || new Set();
      if (senderKey(prev) === senderKey(m) && gap <= R.BURST_S && !addressedToGroup(m, inThread)) {
        rootOf.set(m.id, root); via.set(m.id, "burst");                                  // rule 3
      } else if (senderKey(prev) !== senderKey(m) && gap <= R.ANSWER_S && isShortAnswer(text, m) &&
                 (inThread.has(senderKey(m)) || mentionsSender(prev, m))) {
        rootOf.set(m.id, root); via.set(m.id, "answer"); addMember(root, m);             // rule 4
      }
    }
    prev = m;
  }

  const threads = new Map();  // root id -> {rootId, root, replies}
  for (const m of msgs) {
    const r = rootOf.get(m.id);
    if (r == null) continue;
    if (!threads.has(r)) threads.set(r, { rootId: r, root: byId.get(r) || null, replies: [] });
    threads.get(r).replies.push(m);
  }
  for (const m of msgs) if (m.reply_count && !threads.has(m.id) && !rootOf.has(m.id)) threads.set(m.id, { rootId: m.id, root: m, replies: [] });
  return { rootOf, via, threads, splitAt };
}

// "mọi người ơi…", "@all", tagging someone who isn't in the thread, or a long announcement.
function addressedToGroup(m, inThread) {
  const R = THREAD_RULES;
  const text = m.text || "";
  if (R.TO_GROUP.test(text) || R.GROUP_WORDS.test(text) || text.length > R.LONG_TEXT) return true;
  const tagged = (m.ments || []).map((x) => String(x[2]));
  if (tagged.some((id) => !inThread.has(id))) return true;
  return false;
}
function isShortAnswer(text, m) {
  const R = THREAD_RULES;
  if (m.media === "sticker") return true;
  if (!text || text.length > 40) return false;
  return R.ANSWER.test(text) || R.EMOJI_ONLY.test(text);
}
function mentionsSender(prev, m) {
  const who = senderKey(m);
  return (prev.ments || []).some((x) => String(x[2]) === who) || (m.out && (prev.flags || []).some((f) => f === "mention" || f === "reply_to_me"));
}

// What each rule means, for the AUTO tag's tooltip.
const THREAD_RULE_LABEL = {
  ai: "Grouped by the local AI (it read the conversation) · ⇱ if it's wrong",
  burst: "Grouped automatically: they wrote it right after their reply in this thread",
  answer: "Grouped automatically: a short answer right after a message in this thread",
};

if (typeof module !== "undefined") module.exports = { THREAD_RULES, buildThreadsWith, tsOf, isShortAnswer, addressedToGroup };
