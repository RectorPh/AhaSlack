"use strict";
// Notification sounds, like Slack's Preferences > Notifications > Sound. Each one is synthesized
// with the Web Audio API (no audio files), so they're AhaSlack's own. Played for the same messages
// that notify you: DMs and mentions, when you aren't already looking at that conversation.

let audioCtx = null;
function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
// One note: an oscillator with a quick attack and an exponential fade, optionally gliding in pitch.
function tone(at, { f, to = null, type = "sine", dur = 0.25, gain = 0.3, attack = 0.005 }) {
  const c = ctx(), o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, at);
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur * 0.8);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master());
  o.start(at);
  o.stop(at + dur + 0.02);
}
let masterGain = null;
function master() {
  const c = ctx();
  if (!masterGain) { masterGain = c.createGain(); masterGain.connect(c.destination); }
  masterGain.gain.value = (uiPrefs.soundVolume ?? 70) / 100;
  return masterGain;
}

const SOUNDS = {
  knock: { label: "Knock knock", play: (t) => { tone(t, { f: 210, to: 120, type: "triangle", dur: 0.09, gain: 0.55 }); tone(t + 0.13, { f: 230, to: 130, type: "triangle", dur: 0.1, gain: 0.5 }); } },
  ding: { label: "Ding", play: (t) => { tone(t, { f: 1318.5, dur: 0.7, gain: 0.22 }); tone(t, { f: 2637, dur: 0.35, gain: 0.06 }); } },
  chime: { label: "Chime", play: (t) => { tone(t, { f: 1046.5, dur: 0.45, gain: 0.2 }); tone(t + 0.11, { f: 1568, dur: 0.6, gain: 0.18 }); } },
  pop: { label: "Pop", play: (t) => tone(t, { f: 880, to: 260, dur: 0.09, gain: 0.45 }) },
  plink: { label: "Plink", play: (t) => { tone(t, { f: 1760, type: "triangle", dur: 0.18, gain: 0.25 }); tone(t + 0.06, { f: 2349, type: "triangle", dur: 0.2, gain: 0.15 }); } },
  hum: { label: "Soft hum", play: (t) => { tone(t, { f: 440, dur: 0.5, gain: 0.12, attack: 0.04 }); tone(t + 0.12, { f: 659, dur: 0.55, gain: 0.1, attack: 0.04 }); } },
  boop: { label: "Boop", play: (t) => { tone(t, { f: 523, dur: 0.12, gain: 0.25 }); tone(t + 0.12, { f: 392, dur: 0.16, gain: 0.22 }); } },
  none: { label: "None", play: () => {} },
};
// What plays for what (Slack: Preferences > Notifications > Sound), and muting.
const SOUND_KINDS = {
  dm: { label: "Direct messages", def: "knock" },
  mention: { label: "Mentions & replies to you", def: "ding" },
  thread: { label: "New replies in your threads", def: "pop" },
};
const soundFor = (kind) => {
  const v = (uiPrefs.soundFor || {})[kind] ?? (kind === "dm" || kind === "mention" ? uiPrefs.sound : null);  // older single setting
  return v && SOUNDS[v] ? v : SOUND_KINDS[kind]?.def || "knock";
};
const soundName = () => soundFor("dm");
function mutedUntil() { return uiPrefs.sounds === false ? Infinity : (uiPrefs.soundMuteUntil || 0) > Date.now() ? uiPrefs.soundMuteUntil : 0; }
const soundsOn = (kind = "dm") => !mutedUntil() && soundFor(kind) !== "none";

function playSound(name = soundName()) {
  try { SOUNDS[name]?.play(ctx().currentTime + 0.02); } catch { /* no audio device */ }
}
let lastSoundAt = 0;
function playNotifySound(kind = "dm") {  // at most one every 1.5s, so a burst of messages doesn't rattle
  if (!soundsOn(kind) || Date.now() - lastSoundAt < 1500) return;
  lastSoundAt = Date.now();
  playSound(soundFor(kind));
}

// ---------------------------------------------------------------- mute (⌘⌥⇧M, ⌘K, Preferences)
function setMute(until) {  // until: 0 = sounds on, Infinity = muted until you unmute, or a time
  uiPrefs.sounds = until !== Infinity;
  uiPrefs.soundMuteUntil = until && until !== Infinity ? until : 0;
  saveUi();
  toast(until ? `🔕 Sounds muted${until === Infinity ? "" : " until " + new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", weekday: until - Date.now() > 12 * 3600e3 ? "short" : undefined })}` : "🔔 Sounds on", false, 2500);
}
function toggleMute() { setMute(mutedUntil() ? 0 : Infinity); }
function tomorrowAt9() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }
setInterval(() => { if (uiPrefs.soundMuteUntil && uiPrefs.soundMuteUntil <= Date.now()) { uiPrefs.soundMuteUntil = 0; } }, 30000);

function openSoundSettings() {
  openShortcuts("prefs");
  setTimeout(() => $(".sound-prefs")?.scrollIntoView({ block: "start" }), 50);
}
ACTIONS.push({ group: "This app (not in Slack)", id: "mute", label: "Mute or unmute sounds", def: "Mod+Alt+Shift+M", alt: [], when: "any", run: () => toggleMute() });

// ---------------------------------------------------------------- Preferences > Sounds
function soundSectionHtml() {
  const m = mutedUntil();
  const opts = (sel) => Object.entries(SOUNDS).map(([k, x]) => `<option value="${k}" ${sel === k ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  return `<div class="sound-prefs">
    <div class="sc-group">Sounds</div>
    <label class="pref"><input type="checkbox" name="soundsOn" ${m ? "" : "checked"}> Play sounds${m && m !== Infinity ? ` <span class="sub">(muted until ${new Date(m).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</span>` : ""}</label>
    <div class="sound-grid">${Object.entries(SOUND_KINDS).map(([k, x]) => `<span>${esc(x.label)}</span>
      <select name="soundFor" data-kind="${k}">${opts(soundFor(k))}</select>
      <button type="button" class="btn small" data-sound-test="${k}" title="Play it">▶</button>`).join("")}</div>
    <label class="pref">Volume <input type="range" name="soundVolume" min="0" max="100" value="${uiPrefs.soundVolume ?? 70}"> <span class="sub" id="vol-val">${uiPrefs.soundVolume ?? 70}%</span></label>
    <div class="pref-sub">Sounds play when you aren't already looking at that conversation. ⌘K → “Mute sounds” mutes them for a while.</div></div>`;
}
const _openShortcutsSounds = openShortcuts;
openShortcuts = function (tab = "prefs") {
  _openShortcutsSounds(tab);
  const panel = $("#prefs-panel");
  if (!panel) return;
  const notifHead = [...$$(".sc-group", panel)].find((h) => h.textContent === "Notifications");
  const anchor = notifHead?.nextElementSibling;  // after "Notify me about…"
  (anchor || panel.lastElementChild).insertAdjacentHTML("afterend", soundSectionHtml());
  const box = $(".sound-prefs", panel);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sound-test]");
    if (b) playSound($(`select[data-kind="${b.dataset.soundTest}"]`, box).value);
  });
  box.addEventListener("input", (e) => { if (e.target.name === "soundVolume") $("#vol-val").textContent = e.target.value + "%"; });
  box.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "soundsOn") { uiPrefs.sounds = t.checked; uiPrefs.soundMuteUntil = 0; t.parentElement.querySelector(".sub")?.remove(); }
    if (t.name === "soundFor") { uiPrefs.soundFor = { ...(uiPrefs.soundFor || {}), [t.dataset.kind]: t.value }; playSound(t.value); }
    if (t.name === "soundVolume") { uiPrefs.soundVolume = Number(t.value); playSound(soundFor("dm")); }
    saveUi();
    e.stopPropagation();
  });
};
