import { contextBridge, ipcRenderer } from "electron";

// Preload for the recovery banner view ONLY (never the hosted workspace content).
contextBridge.exposeInMainWorld("awBanner", { retry: () => ipcRenderer.send("aw:banner-retry") });
