import { app } from "electron";
import { appendDiagnostic } from "./diagnostics";
import { join } from "node:path";

export const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000;

let updateDownloaded: string | null = null;
/** Version of a downloaded update waiting for a restart, or null. */
export const pendingUpdate = (): string | null => updateDownloaded;

const logFile = (): string => join(app.getPath("userData"), "diagnostics.log");
function record(code: string, raw: string): void {
  appendDiagnostic(logFile(), { context: "updater", code, raw, account: "" });
}

/** electron-updater logger that writes into the diagnostics log instead of being null. */
export const updaterLogger = {
  info: (m?: unknown) => record("info", String(m)),
  warn: (m?: unknown) => record("warn", String(m)),
  error: (m?: unknown) => record("error", String(m)),
  debug: () => undefined,
};

let wired = false;

/** electron-updater against GitHub Releases. Every attempt and failure lands in diagnostics.log;
 * failures are never fatal. Safe to call repeatedly (launch, timer, resume). */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    if (!wired) {
      wired = true;
      autoUpdater.logger = updaterLogger as never;
      autoUpdater.on("update-downloaded", (info) => {
        updateDownloaded = info.version;
        record("downloaded", `update ${info.version} downloaded; installs on restart`);
      });
      autoUpdater.on("error", (err) => record("error", `${err?.stack ?? err}`));
    }
    record("check", `checking from ${app.getVersion()}`);
    const r = await autoUpdater.checkForUpdatesAndNotify();
    record("result", r?.updateInfo ? `latest feed version ${r.updateInfo.version}` : "no update info");
  } catch (err) {
    record("error", `update check failed: ${(err as Error)?.stack ?? err}`);
  }
}

/** Install a downloaded update now (restarts the app). Returns false when none is pending. */
export async function installPendingUpdate(): Promise<boolean> {
  if (!updateDownloaded) return false;
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.quitAndInstall(false, true);
  return true;
}
