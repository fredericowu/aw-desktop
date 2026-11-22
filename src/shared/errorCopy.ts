/**
 * The single source of user-facing failure copy (ADR 0001, decision 4).
 * Plain language only: no engine, VM, container or image wording reaches the user.
 * Shared by the silent preflight (main) and the error classifier (main), rendered by the renderer.
 */
import type { PreflightCode } from "./preflight";

export type FailureCode = PreflightCode | "download_failed" | "start_failed";

/** Detail that is safe to show: the code's plain copy only. Raw stderr goes to the diagnostics log. */
export const FAILURE_COPY: Record<Exclude<FailureCode, "low_disk">, string> = {
  virtualization_unavailable: "This Mac can't run local workspaces.",
  low_memory: "Not enough memory to start a local workspace.",
  engine_missing: "AW Desktop is incomplete. Reinstall it and try again.",
  path_too_long: "This Mac's account name is too long to run local workspaces.",
  download_failed: "Couldn't download the workspace. Check your connection and try again.",
  start_failed: "The workspace couldn't start. Retry, or copy details for support.",
};

/** `gb` is the amount to free when known (preflight knows it; a classified failure does not). */
export function lowDiskCopy(gb?: number): string {
  return gb && gb > 0 ? `Not enough free disk space. Free up ${gb} GB and try again.` : "Not enough free disk space. Free up some space and try again.";
}

export function failureCopy(code: FailureCode, gb?: number): string {
  return code === "low_disk" ? lowDiskCopy(gb) : FAILURE_COPY[code];
}

/** Progress copy: the six internal step ids collapse to two phases (ADR 0001). */
export const PHASE_LABEL = { preparing: "Preparing your workspace", starting: "Starting workspace" } as const;

/** Supervisor status copy (ADR 0001): same plain-language rule as the failure copy above. */
export const SUPERVISOR_COPY = {
  starting: "Starting workspace...",
  needs_attention: "This workspace needs attention. Retry, or copy details for support.",
} as const;
