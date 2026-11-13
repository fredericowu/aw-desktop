import { app } from "electron";
import log from "node:console";

/** electron-updater against GitHub Releases (Architect design §3). No-ops
 * until a signed release actually exists on fredericowu/aw-desktop — safe
 * to call unconditionally; failures are logged, never fatal. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.logger = null;
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    log.warn("aw-desktop: update check failed", err);
  }
}
