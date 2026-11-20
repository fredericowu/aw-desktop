import type { BootstrapProgress, BootstrapStepId, LocalHostStatus, WorkspaceInfo } from "./types";

export type Preflight =
  | { action: "proceed"; needsToken: boolean }
  | { action: "block"; message: string };

/** Pre-flight BEFORE any row is created or token minted. `slug` is set when
 * resuming an existing row. One full workspace per machine is a hard
 * aw-remote-host limit, and an existing credential silently wins over a new
 * token, so a linked Mac must be refused up front. */
export function decidePreflight(host: LocalHostStatus, slug?: string, rowHostId?: string | null): Preflight {
  if (!host.linked) return { action: "proceed", needsToken: true };
  if (host.unknown) {
    return {
      action: "block",
      message:
        "This Mac already has aw-remote-host state that we could not read, so we can't tell whether it hosts a workspace. Nothing was created. Run `aw-remote-host status` in a terminal, or remove the old link first.",
    };
  }
  if (slug && host.workspaceSlug === slug) return { action: "proceed", needsToken: false };
  // Partial registration: the CLI saved the credential but its slug write
  // failed, so status reports a linked host with no workspace. If the row on
  // the control plane is bound to THIS host id, it is our own half-finished
  // setup and must stay resumable (no token: the credential already exists).
  if (slug && !host.workspaceSlug && host.remoteHostId && rowHostId && rowHostId === host.remoteHostId) {
    return { action: "proceed", needsToken: false };
  }
  const which = host.workspaceSlug ? ` ("${host.workspaceSlug}")` : "";
  return {
    action: "block",
    message: `This Mac already hosts a workspace${which}. A Mac can run only one full local workspace, so a second one can't be set up here. Nothing was created.`,
  };
}

export type RowState = "open-here" | "open-remote" | "finish" | "blocked";

/** Resume state machine for a LOCAL row against this Mac. */
export function rowState(ws: WorkspaceInfo, host: LocalHostStatus | null): RowState {
  const here = !!host && host.linked && !host.unknown && host.workspaceSlug === ws.name;
  if (ws.status === "running") return here ? "open-here" : "open-remote";
  if (!host) return "finish";
  return decidePreflight(host, ws.name, ws.remote_host_id).action === "block" ? "blocked" : "finish";
}

export const STEP_ORDER: BootstrapStepId[] = ["cli", "token", "link", "podman", "postgres", "redis", "workspace", "running"];

export const STEP_LABEL: Record<BootstrapStepId, string> = {
  cli: "Install aw-remote-host",
  token: "Authorize this Mac",
  link: "Link this Mac",
  podman: "Install Podman",
  postgres: "Set up database",
  redis: "Set up cache",
  workspace: "Start workspace",
  running: "Wait for workspace",
};

/** Never let a token reach a log, the renderer or the progress buffer. */
export function redact(line: string): string {
  return line.replace(/\baw(?:bs|lk)_[A-Za-z0-9_\-.]+/g, "[redacted]");
}

export function stepFromLine(line: string): BootstrapStepId | null {
  const m = /(?:^|\s)(podman|postgres|redis|workspace):/.exec(line);
  if (m) return m[1] as BootstrapStepId;
  if (/\bregistered\b|\blinked to workspace\b|workspace "[^"]+" linked|Detaching/i.test(line)) return "link";
  return null;
}

const MAX_LINES = 30;

export function startProgress(slug: string): BootstrapProgress {
  return { slug, phase: "running", step: null, done: [], lines: [] };
}

export function advance(p: BootstrapProgress, step: BootstrapStepId): BootstrapProgress {
  const idx = STEP_ORDER.indexOf(step);
  // Steps never move backwards (a late "podman: ..." line after postgres started is noise).
  if (p.step && STEP_ORDER.indexOf(p.step) >= idx) return p;
  return { ...p, step, done: STEP_ORDER.slice(0, idx) };
}

export function appendLine(p: BootstrapProgress, raw: string): BootstrapProgress {
  const line = redact(raw).trimEnd();
  if (!line) return p;
  let next: BootstrapProgress = { ...p, lines: [...p.lines, line].slice(-MAX_LINES) };
  const step = stepFromLine(line);
  if (step) next = advance(next, step);
  return next;
}

export function fail(p: BootstrapProgress, error: string): BootstrapProgress {
  return { ...p, phase: "failed", error: redact(error), failedStep: p.step ?? "cli" };
}

export function complete(p: BootstrapProgress): BootstrapProgress {
  return { ...p, phase: "done", step: "running", done: [...STEP_ORDER] };
}
