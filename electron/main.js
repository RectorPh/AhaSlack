// AhaSlack: the desktop shell. It starts the local Python server (server.py, run with uv),
// waits for it, and shows the page in a native macOS window. The server only listens on
// 127.0.0.1; links to the web open in your browser.
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.INBOX_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}/`;
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..");
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "AhaSlack");
let server = null;
let win = null;
let quitting = false;
let serverLog = "";

// GUI apps on macOS don't get your shell PATH, so look for uv where it's usually installed.
function findUv() {
  const candidates = [process.env.UV, path.join(os.homedir(), ".local/bin/uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try {
    return execFileSync("/bin/zsh", ["-lc", "command -v uv"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- first-start progress
// The first start downloads AhaSlack's Python packages (about 150 MB, mostly the Inbox Manager's
// claude-agent-sdk). uv prints what it's doing; the setup window shows it so nothing looks stuck.
let progressText = "";
let lastOutputAt = Date.now();
function reportProgress(chunk) {
  lastOutputAt = Date.now();
  for (const raw of String(chunk).split(/\r?\n/)) {
    const l = raw.trim();
    let m, msg = null;
    if ((m = l.match(/^Downloading (\S+) \(([^)]+)\)/))) msg = `Downloading ${m[1]} (${m[2]})…`;
    else if ((m = l.match(/^Downloaded (\S+)/))) msg = `Downloaded ${m[1]}`;
    else if ((m = l.match(/^(Prepared|Installed|Resolved) (\d+) packages?/))) msg = `${m[1]} ${m[2]} packages`;
    else if (/AhaSlack engine ready/.test(l)) msg = "✓ AhaSlack's engine is installed";
    else if (/Uvicorn running|Application startup complete/.test(l)) msg = "Connecting to Telegram…";
    if (msg) {
      progressText = msg;
      setupWin?.webContents.send("setup:progress", msg);
    }
  }
}
// Started as soon as uv is there (while you get your API keys and log in), so opening AhaSlack
// afterwards doesn't wait for the download.
let preparing = null;
function prepareEngine() {
  if (preparing || server) return preparing;
  const uv = findUv();
  if (!uv) return null;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
  preparing = new Promise((resolve) => {
    const p = spawn(uv, ["run", "--script", "server.py", "--prepare"], {
      cwd: SERVER_DIR, env: { ...process.env, PATH: `${path.dirname(uv)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}` },
    });
    for (const s of [p.stdout, p.stderr]) s.on("data", (d) => { reportProgress(d); log.write(d); });
    p.on("exit", (code) => {
      if (code !== 0) {
        preparing = null;  // try again later (e.g. when you click Open AhaSlack)
        setupWin?.webContents.send("setup:progress", "The download stopped. It will continue when you open AhaSlack.");
      }
      resolve(code === 0);
    });
  });
  return preparing;
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(BASE + "api/state", { headers: { Host: `127.0.0.1:${PORT}` } }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (await ping()) return true;  // already running (for example `uv run --script server.py` in a terminal)
  const st = setupStatus();
  if (!st.uv || !st.session) return "setup";  // first run: the onboarding window walks you through it
  const uv = findUv();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
  server = spawn(uv, ["run", "--script", "server.py"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PATH: `${path.dirname(uv)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`, INBOX_PORT: String(PORT) },
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (d) => { serverLog = (serverLog + d.toString()).slice(-4000); log.write(d); reportProgress(d); });
  }
  let exited = false;
  server.on("exit", (code) => {
    exited = true;
    if (!quitting && win) win.webContents.executeJavaScript(`document.querySelector('#status') && (document.querySelector('#status').innerHTML = '<span class="err">Server stopped (code ${code})</span>')`).catch(() => {});
  });
  // The first start downloads ~150 MB: keep waiting while uv is still printing progress. Give up only
  // if it has been silent for 3 minutes, or after 30 minutes in all.
  const started = Date.now();
  lastOutputAt = Date.now();
  while (true) {
    if (await ping()) return true;
    if (exited) break;
    if (Date.now() - started > 30 * 60e3 || (Date.now() - lastOutputAt > 3 * 60e3 && Date.now() - started > 90e3)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (/Not logged in|session expired/i.test(serverLog)) return "setup";
  await dialog.showMessageBox({ type: "error", message: "AhaSlack's server didn't start", detail: serverLog.slice(-1500) || "No output." });
  return false;
}

// ---------------------------------------------------------------- first run: onboarding
// A window that walks you through connecting Telegram: install uv, get API keys at my.telegram.org,
// log in (in Terminal, so your code and password never pass through the app), edit config.toml.
// Each step ticks itself off by looking at the files the login creates.
const TG_HOME = process.env.TG_INBOX_HOME || path.join(os.homedir(), ".config", "telegram-inbox");
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
let claudePath = null;
function findClaude() {
  if (claudePath) return claudePath;
  const candidates = [path.join(os.homedir(), ".local/bin/claude"), path.join(os.homedir(), ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  claudePath = candidates.find((c) => fs.existsSync(c)) || null;
  return claudePath;
}
function setupStatus() {
  const has = (f) => fs.existsSync(path.join(TG_HOME, f));
  return { uv: !!findUv(), creds: has("credentials.json"), session: has("inbox.session"), config: has("config.toml"), claude: !!findClaude(), engine: !!preparing };
}
function inTerminal(cmd) {
  execFileSync("/usr/bin/osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", 'tell application "Terminal" to activate']);
}
let setupWin = null;
function showOnboarding(mode = "") {
  if (setupWin) { if (mode) setupWin.webContents.send("setup:mode", mode); return setupWin.focus(); }
  setupWin = new BrowserWindow({
    width: 1080, height: 740, minWidth: 840, minHeight: 560, title: "Welcome to AhaSlack",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 }, backgroundColor: "#4b1f52", show: false,
    webPreferences: { preload: path.join(__dirname, "onboarding-preload.js"), contextIsolation: true, sandbox: true },
  });
  setupWin.loadFile(path.join(__dirname, "onboarding.html"), mode ? { query: { mode } } : undefined);
  setupWin.once("ready-to-show", () => setupWin.show());
  setupWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWin.webContents.on("will-navigate", (e) => e.preventDefault());
  setupWin.on("closed", () => { setupWin = null; if (!win && !quitting) app.quit(); });
}
ipcMain.handle("setup:status", () => {
  const st = setupStatus();
  if (st.uv && !st.engine) prepareEngine();  // start the big download early, in the background
  return st;
});
ipcMain.handle("setup:progress-now", () => progressText);
ipcMain.handle("setup:act", async (_e, name) => {
  if (name === "install-uv") inTerminal("curl -LsSf https://astral.sh/uv/install.sh | sh");
  else if (name === "open-mytg") shell.openExternal("https://my.telegram.org/auth");
  else if (name === "login") {
    const uv = findUv();
    if (!uv) return dialog.showMessageBox(setupWin, { type: "info", message: "Install uv first (step 1)." });
    inTerminal(`cd ${shq(SERVER_DIR)} && ${shq(uv)} run --script login.py`);
  } else if (name === "open-config") {
    const f = path.join(TG_HOME, "config.toml");
    if (!fs.existsSync(f)) {
      fs.mkdirSync(TG_HOME, { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(SERVER_DIR, "config.example.toml"), f);
      fs.chmodSync(f, 0o600);
    }
    execFileSync("/usr/bin/open", ["-t", f]);  // your default text editor
  } else if (name === "open-claude") shell.openExternal("https://claude.com/claude-code");
  else if (name === "open-log") shell.openPath(path.join(LOG_DIR, "server.log"));
  else if (name === "open-readme") shell.openExternal("https://github.com/RectorPh/AhaSlack#getting-started");
  else if (name === "continue") {
    const ok = await startServer();
    if (ok === true) { if (!win) createWindow(); setupWin?.close(); }
    else if (ok === "setup") dialog.showMessageBox(setupWin, { type: "info", message: "Not connected yet", detail: "Finish steps 1 to 3 first. If you did, the login may have expired: log in again in step 3." });
  }
  return setupStatus();
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 720, minHeight: 480,
    title: "AhaSlack", titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: "#3b1640", show: false,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.loadURL(BASE);
  win.once("ready-to-show", () => win.show());
  // External links (t.me, docs, ...) open in your browser; the app only ever shows the local page.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|tg|mailto):/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(BASE)) { e.preventDefault(); shell.openExternal(url); } });
  // Dock badge: the page puts the unread-mention count in its title, like "(3) AhaSlack"
  win.on("page-title-updated", (e, title) => { e.preventDefault(); const m = title.match(/^\((\d+)\)/); app.dock?.setBadge(m ? m[1] : ""); });
  win.on("closed", () => { win = null; });
}

// The menu gives the app the Slack keys a browser keeps for itself: ⌘W, ⌘⇧W, ⌘Q, ⌘N, ⌘T.
// Edit has no Undo item on purpose: ⌘Z goes to the page (undo formatting / unsend, like Slack).
function buildMenu() {
  const page = (js) => () => win?.webContents.executeJavaScript(js).catch(() => {});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "AhaSlack", submenu: [
      { role: "about" }, { type: "separator" },
      { label: "Preferences…", accelerator: "CmdOrCtrl+,", click: page("openShortcuts()") },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
    ] },
    { label: "File", submenu: [
      { label: "New Message", accelerator: "CmdOrCtrl+N", click: page('openSwitcher("compose")') },
      { label: "Jump to…", accelerator: "CmdOrCtrl+T", click: page("openSwitcher()") },
      { type: "separator" },
      { label: "Close Window", accelerator: "CmdOrCtrl+W", click: () => win?.close() },
      { label: "Reopen Last Closed Window", accelerator: "CmdOrCtrl+Shift+W", click: () => { if (!win) createWindow(); else win.show(); } },
    ] },
    { label: "Edit", submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "selectAll" }] },
    { label: "View", submenu: [
      { label: "Calm Space", accelerator: "CmdOrCtrl+J", click: page("toggleCalm()") },
      { label: "Mute Sounds", accelerator: "CmdOrCtrl+Alt+Shift+M", click: page("toggleMute()") },
      { label: "Sound Settings…", click: page("openSoundSettings()") },
      { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: page('openShortcuts("keys")') },
      { label: "Setup Guide", click: () => showOnboarding() },
      { label: "Server Log", click: () => shell.openPath(path.join(LOG_DIR, "server.log")) },
    ] },
  ]));
}

// Notification sounds play without a click first (they're synthesized in the page).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Opened from the disk image or a download folder: offer to move into Applications, like most Mac apps.
async function offerMoveToApplications() {
  if (!app.isPackaged || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox({
    type: "question", buttons: ["Move to Applications", "Not now"], defaultId: 0, cancelId: 1,
    message: "Move AhaSlack to your Applications folder?",
    detail: "Then you can open it from Launchpad, Spotlight and the Dock like any other app.",
  });
  if (response === 0) {
    try { app.moveToApplicationsFolder(); } catch (e) { dialog.showErrorBox("Couldn't move AhaSlack", String(e.message || e)); }
  }
}

app.whenReady().then(async () => {
  buildMenu();
  await offerMoveToApplications();
  const starting = startServer();
  // Still not up after a moment (first start: downloading)? Show the progress instead of nothing.
  const slow = setTimeout(() => { if (!win) showOnboarding("starting"); }, 2500);
  const ok = await starting;
  clearTimeout(slow);
  if (ok === "setup") return showOnboarding();
  if (!ok) { quitting = true; return app.quit(); }
  createWindow();
  setupWin?.close();
});
app.on("activate", () => { if (!win && server !== undefined) createWindow(); });
app.on("window-all-closed", () => {});  // stay in the Dock like Slack; ⌘Q quits
app.on("before-quit", () => { quitting = true; server?.kill("SIGTERM"); });
