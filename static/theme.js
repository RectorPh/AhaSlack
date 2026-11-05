"use strict";
// Themes, like Slack's Preferences > Themes: light / dark / follow the system, a set of sidebar
// color themes, and custom colors. Saved with your other preferences (uiPrefs.theme) and cached in
// localStorage so the first paint already has your colors.

const THEMES = {
  aubergine: { label: "Aubergine", side: "#4b1f52", active: "#1d6fa5", badge: "#d93a63", chrome: "#3b1640" },
  jade:      { label: "Jade",      side: "#0f4c3a", active: "#2bac76", badge: "#e0516b" },
  lagoon:    { label: "Lagoon",    side: "#1b3d66", active: "#3aa3e3", badge: "#e8912d" },
  indigo:    { label: "Indigo",    side: "#2b2f6b", active: "#6c63ff", badge: "#ff6b8a" },
  ember:     { label: "Ember",     side: "#5a1e1e", active: "#e8743b", badge: "#f2b94c" },
  forest:    { label: "Forest",    side: "#22341f", active: "#5c9e45", badge: "#d93a63" },
  graphite:  { label: "Graphite",  side: "#2c2d30", active: "#1d9bd1", badge: "#e01e5a" },
  paper:     { label: "Paper",     side: "#f6f5f2", active: "#1d6fa5", badge: "#d93a63" },
  sand:      { label: "Sand",      side: "#f4ece4", active: "#e8743b", badge: "#d93a63" },
};
const MODES = { system: "Sync with your computer", light: "Light", dark: "Dark" };

// ---------------------------------------------------------------- color math
const hex2rgb = (h) => { h = h.replace("#", ""); if (h.length === 3) h = [...h].map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); };
const luminance = (h) => { const [r, g, b] = hex2rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

function themeVars(t, dark) {
  let side = t.side;
  const lightSide = luminance(side) > 0.45;
  if (dark && !lightSide) side = mix(side, "#0d0d10", 0.32);  // a deeper sidebar at night, like Slack
  const ink = lightSide ? "#1d1c1d" : "#ffffff";
  return {
    "--side-bg": side,
    "--chrome": t.chrome && !dark ? t.chrome : mix(side, lightSide ? "#000000" : "#000000", lightSide ? 0.07 : 0.22),
    "--side-hover": mix(side, lightSide ? "#000000" : "#ffffff", lightSide ? 0.06 : 0.09),
    "--side-active": t.active,
    "--side-fg": mix(side, ink, 0.85),
    "--side-dim": mix(side, ink, 0.6),
    "--side-strong": ink,
    "--chrome-fg": ink,
    "--overlay": lightSide ? "#0000001a" : "#ffffff21",
    "--badge": t.badge,
  };
}
function currentTheme() {
  const t = uiPrefs.theme || {};
  return { mode: t.mode || "system", name: t.name || "aubergine", custom: t.custom || null };
}
const systemDark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(t = currentTheme()) {
  const root = document.documentElement;
  const dark = t.mode === "dark" || (t.mode === "system" && systemDark.matches);
  if (t.mode === "system") delete root.dataset.mode; else root.dataset.mode = t.mode;
  const preset = t.name === "custom" && t.custom ? t.custom : THEMES[t.name] || THEMES.aubergine;
  const vars = themeVars(preset, dark);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  try { localStorage.setItem("ahaslack-theme", JSON.stringify({ mode: t.mode, vars })); } catch { /* fine */ }
}
systemDark.addEventListener("change", () => applyTheme());
function setTheme(patch) {
  uiPrefs.theme = { ...currentTheme(), ...patch };
  applyTheme();
  saveUi();
}

// ---------------------------------------------------------------- Preferences > Themes
function themeSectionHtml() {
  const t = currentTheme();
  const swatch = (k, p) => `<button type="button" class="theme-swatch ${t.name === k ? "on" : ""}" data-theme="${k}" title="${esc(p.label)}">
      <span class="ts-side" style="background:${p.side};color:${luminance(p.side) > 0.45 ? "#1d1c1d" : "#fff"}"><i style="background:${p.active}"></i><i></i><i></i><b style="background:${p.badge}"></b></span><span class="ts-name">${esc(p.label)}</span></button>`;
  const c = t.custom || { side: "#4b1f52", active: "#1d6fa5", badge: "#d93a63" };
  return `<div class="theme-prefs">
    <div class="sc-group">Appearance</div>
    <div class="mode-row">${Object.entries(MODES).map(([k, l]) => `<label class="mode-opt ${t.mode === k ? "on" : ""}"><input type="radio" name="themeMode" value="${k}" ${t.mode === k ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>
    <div class="sc-group">Themes</div>
    <div class="theme-grid">${Object.entries(THEMES).map(([k, p]) => swatch(k, p)).join("")}
      <button type="button" class="theme-swatch ${t.name === "custom" ? "on" : ""}" data-theme="custom" title="Your own colors">
        <span class="ts-side" style="background:${c.side}"><i style="background:${c.active}"></i><i></i><i></i><b style="background:${c.badge}"></b></span><span class="ts-name">Custom</span></button></div>
    <div class="custom-colors" ${t.name === "custom" ? "" : "hidden"}>
      <label>Sidebar <input type="color" name="tcSide" value="${c.side}"></label>
      <label>Selected item <input type="color" name="tcActive" value="${c.active}"></label>
      <label>Badges <input type="color" name="tcBadge" value="${c.badge}"></label>
    </div></div>`;
}
function wireThemeSection(panel) {
  const box = $(".theme-prefs", panel);
  box.addEventListener("click", (e) => {
    const sw = e.target.closest("[data-theme]");
    if (!sw) return;
    const name = sw.dataset.theme;
    setTheme(name === "custom" ? { name, custom: currentTheme().custom || { side: "#4b1f52", active: "#1d6fa5", badge: "#d93a63" } } : { name });
    $$(".theme-swatch", box).forEach((b) => b.classList.toggle("on", b === sw));
    $(".custom-colors", box).hidden = name !== "custom";
  });
  box.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.name?.startsWith("tc")) return;
    const c = { ...(currentTheme().custom || {}), side: $('[name="tcSide"]', box).value, active: $('[name="tcActive"]', box).value, badge: $('[name="tcBadge"]', box).value };
    uiPrefs.theme = { ...currentTheme(), name: "custom", custom: c };
    applyTheme();
    const sw = $('[data-theme="custom"] .ts-side', box);
    sw.style.background = c.side; sw.querySelector("i").style.background = c.active; sw.querySelector("b").style.background = c.badge;
  });
  box.addEventListener("change", (e) => {
    if (e.target.name === "themeMode") {
      setTheme({ mode: e.target.value });
      $$(".mode-opt", box).forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
    } else if (e.target.name?.startsWith("tc")) saveUi();
    e.stopPropagation();  // not a reading/sidebar preference
  });
}

// Add the section to the top of Preferences (⌘,), above reading and notifications.
const _openShortcutsThemed = openShortcuts;
openShortcuts = function (tab = "prefs") {
  _openShortcutsThemed(tab);
  const panel = $("#prefs-panel");
  if (!panel) return;
  panel.insertAdjacentHTML("afterbegin", themeSectionHtml());
  wireThemeSection(panel);
};

applyTheme();  // app.js calls it again once your saved preferences arrive
