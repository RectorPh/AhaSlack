// AhaSlack: the desktop shell. It starts the local Python server (server.py, run with uv),
// waits for it, and shows the page in a native macOS window. The server only listens on
// 127.0.0.1; links to the web open in your browser.
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
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

function ping() {
  return new Promise((resolve) => {
    const req = http.get(BASE + "api/state", { headers: { Host: `127.0.0.1:${PORT}` } }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (await ping()) return true;  // already running (for example `uv run --script server.py` in a terminal)
  const uv = findUv();
  if (!uv) {
    await dialog.showMessageBox({ type: "error", message: "AhaSlack needs uv", detail: "Install it with:\n  curl -LsSf https://astral.sh/uv/install.sh | sh\nthen open AhaSlack again." });
    return false;
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
  server = spawn(uv, ["run", "--script", "server.py"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PATH: `${path.dirname(uv)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`, INBOX_PORT: String(PORT) },
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (d) => { serverLog = (serverLog + d.toString()).slice(-4000); log.write(d); });
  }
  let exited = false;
  server.on("exit", (code) => {
    exited = true;
    if (!quitting && win) win.webContents.executeJavaScript(`document.querySelector('#status') && (document.querySelector('#status').innerHTML = '<span class="err">Server stopped (code ${code})</span>')`).catch(() => {});
  });
  for (let i = 0; i < 180; i++) {  // first start downloads Python packages, so allow a while
    if (await ping()) return true;
    if (exited) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (/Not logged in|session expired/i.test(serverLog)) return loginFlow();
  await dialog.showMessageBox({ type: "error", message: "AhaSlack's server didn't start", detail: serverLog.slice(-1500) || "No output." });
  return false;
}

// First run: log in to Telegram in Terminal (you type the code and 2FA password there, never in the app).
async function loginFlow() {
  const { response } = await dialog.showMessageBox({
    type: "info", buttons: ["Open Terminal to log in", "Quit"], defaultId: 0,
    message: "Log in to Telegram first",
    detail: "AhaSlack reads your Telegram with your own login. A Terminal window will ask for your api_id and api_hash (from my.telegram.org), your phone number and the code Telegram sends you. Open AhaSlack again when it says \"Logged in\".",
  });
  if (response === 0) {
    const cmd = `cd ${JSON.stringify(SERVER_DIR)} && ${JSON.stringify(findUv())} run --script login.py`;
    execFileSync("/usr/bin/osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", 'tell application "Terminal" to activate']);
  }
  return false;
}

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
      { label: "Calm Space", accelerator: "CmdOrCtrl+Alt+C", click: page("toggleCalm()") },
      { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: page("openShortcuts()") },
      { label: "Server Log", click: () => shell.openPath(path.join(LOG_DIR, "server.log")) },
    ] },
  ]));
}

app.whenReady().then(async () => {
  buildMenu();
  if (!(await startServer())) { quitting = true; return app.quit(); }
  createWindow();
});
app.on("activate", () => { if (!win && server !== undefined) createWindow(); });
app.on("window-all-closed", () => {});  // stay in the Dock like Slack; ⌘Q quits
app.on("before-quit", () => { quitting = true; server?.kill("SIGTERM"); });
