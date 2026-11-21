import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { is } from "./env";
import { isAllowedTarget } from "./navPolicy";

const RENDERER_DEV_URL = process.env["ELECTRON_RENDERER_URL"];

/** The native (local) auth window — splash, login/signup, workspace
 * picker. Preload is scoped to THIS window only; it is never attached to
 * the shell window below (hardening default #9 on the Architect card). */
export function createAuthWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: false,
    title: "AW Desktop",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The picker's runtime-install guidance links out (Docker Desktop /
  // Podman downloads): always the system browser, never a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (is.dev && RENDERER_DEV_URL) {
    win.loadURL(RENDERER_DEV_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

/** The main shell window — a plain Chromium BrowserWindow loading the
 * hosted workspace UI UNMODIFIED. No preload, no nodeIntegration, no
 * webview tag: this frame renders remote content and must carry none of
 * this app's own privilege (hardening default #9). `will-navigate` is
 * allowlisted to the apex, and `window.open` is routed to the system
 * browser rather than spawning a second Electron window. */
export function createShellWindow(url: string, localOrigin?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "AW Desktop",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedTarget(targetUrl, localOrigin)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  win.loadURL(url);
  return win;
}
