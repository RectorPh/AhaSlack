// The onboarding window's only bridge to the app: read setup status, and ask for a few fixed actions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setup", {
  status: () => ipcRenderer.invoke("setup:status"),
  act: (name) => ipcRenderer.invoke("setup:act", String(name)),
  progress: () => ipcRenderer.invoke("setup:progress-now"),
  onProgress: (cb) => ipcRenderer.on("setup:progress", (_e, msg) => cb(String(msg))),
  onMode: (cb) => ipcRenderer.on("setup:mode", (_e, mode) => cb(String(mode))),
});
