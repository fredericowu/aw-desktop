/**
 * The single source of user-facing failure copy (ADR 0001, decision 4).
 * Plain language only: no engine, VM, container or image wording reaches the user.
 * Shared by the silent preflight (main) and the error classifier (main), rendered by the renderer.
 */
import type { PreflightCode } from "./preflight";

export type FailureCode = PreflightCode | "download_failed" | "start_failed" | "engine_unresponsive";

/** Whose hardware the copy talks about. Mac copy is unchanged; Windows says "PC". */
export type Host = "mac" | "pc";
export const hostForPlatform = (platform: string): Host => (platform === "win32" ? "pc" : "mac");

/** Detail that is safe to show: the code's plain copy only. Raw stderr goes to the diagnostics log. */
export const FAILURE_COPY: Record<Exclude<FailureCode, "low_disk">, string> = {
  virtualization_unavailable: "This Mac can't run local workspaces.",
  low_memory: "Not enough memory to start a local workspace.",
  engine_missing: "AW Desktop is incomplete. Reinstall it and try again.",
  path_too_long: "This Mac's account name is too long to run local workspaces.",
  // Windows only. PO decision 3: the official feature name is allowed here (and only in prerequisite/recovery copy),
  // because the user has to find it in Windows. Administrator access and a restart are named where they are needed.
  wsl_missing: "Windows Subsystem for Linux (WSL) is not set up on this PC. It needs a one-time setup with administrator access and a restart.",
  ssh_missing: "The Windows OpenSSH Client is not installed. Add it under Settings, Apps, Optional features, then try again.",
  wsl_unresponsive: "Windows Subsystem for Linux (WSL) is not responding. Restart your PC, then try again.",
  engine_unresponsive: "The workspace did not respond in time. If this keeps happening, restart your PC and try again.",
  download_failed: "Couldn't download the workspace. Check your connection and try again.",
  start_failed: "The workspace couldn't start. Retry, or copy details for support.",
};

/** `gb` is the amount to free when known (preflight knows it; a classified failure does not). */
export function lowDiskCopy(gb?: number): string {
  return gb && gb > 0 ? `Not enough free disk space. Free up ${gb} GB and try again.` : "Not enough free disk space. Free up some space and try again.";
}

/** Setup steps for a missing prerequisite (Windows). */
export const WSL_SETUP_STEPS = [
  "Open the Start menu, search for Command Prompt, right-click it and choose Run as administrator.",
  "Run: wsl --install --no-distribution",
  "Restart your PC, then open AW Desktop and choose Check again.",
] as const;

export function failureCopy(code: FailureCode, gb?: number, host: Host = "mac"): string {
  if (code === "low_disk") return lowDiskCopy(gb);
  const text = FAILURE_COPY[code];
  return host === "pc" ? text.replace(/This Mac's account name/, "Your account name").replace(/This Mac/, "This PC") : text;
}

/** Progress copy: the six internal step ids collapse to two phases (ADR 0001). */
export const PHASE_LABEL = { preparing: "Preparing your workspace", starting: "Starting workspace" } as const;

/** Supervisor status copy (ADR 0001): same plain-language rule as the failure copy above. */
export const SUPERVISOR_COPY = {
  starting: "Starting workspace...",
  needs_attention: "This workspace needs attention. Retry, or copy details for support.",
} as const;

/** Upgrade copy (same plain-language rule): never engine, image or container wording. */
export const UPGRADE_COPY = {
  title: "Upgrade workspace",
  confirm: "This updates the workspace to the version bundled with this app. Your data and installed apps are kept. The workspace is unavailable for a few minutes, and if anything goes wrong it is restored to how it is now.",
  progress: "Upgrading your workspace",
  failedRestored: "The upgrade didn't complete. Your workspace was restored and works as before. Retry, or copy details for support.",
  failedAttention: "The upgrade didn't complete and the workspace needs attention. Retry to finish restoring it, or copy details for support.",
} as const;
