"use strict";

// Expose only purpose-specific actions, never Node or arbitrary filesystem access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAtlas", {
  openSuggestion: (payload) => ipcRenderer.invoke("codex:open-suggestion", payload),
  openFeedback: (kind) => ipcRenderer.invoke("feedback:open", kind)
});
