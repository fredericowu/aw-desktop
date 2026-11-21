import type { BootstrapProgress, BootstrapStepId } from "./types";

export const STEP_ORDER: BootstrapStepId[] = ["machine", "image", "postgres", "redis", "workspace", "running"];

export const STEP_LABEL: Record<BootstrapStepId, string> = {
  machine: "Start the Podman machine",
  image: "Download the workspace image",
  postgres: "Set up database",
  redis: "Set up cache",
  workspace: "Start workspace",
  running: "Wait for workspace",
};

/** Never let a token reach a log, the renderer or the progress buffer. */
export function redact(line: string): string {
  return line.replace(/\baw(?:bs|lk)_[A-Za-z0-9_\-.]+/g, "[redacted]");
}

const MAX_LINES = 30;

export function startProgress(slug: string): BootstrapProgress {
  return { slug, phase: "running", step: null, done: [], lines: [] };
}

export function advance(p: BootstrapProgress, step: BootstrapStepId): BootstrapProgress {
  const idx = STEP_ORDER.indexOf(step);
  // Steps never move backwards (a late line from an earlier step is noise).
  if (p.step && STEP_ORDER.indexOf(p.step) >= idx) return p;
  return { ...p, step, done: STEP_ORDER.slice(0, idx) };
}

export function appendLine(p: BootstrapProgress, raw: string): BootstrapProgress {
  const line = redact(raw).trimEnd();
  if (!line) return p;
  return { ...p, lines: [...p.lines, line].slice(-MAX_LINES) };
}

export function fail(p: BootstrapProgress, error: string): BootstrapProgress {
  return { ...p, phase: "failed", error: redact(error), failedStep: p.step ?? "machine" };
}

export function complete(p: BootstrapProgress): BootstrapProgress {
  return { ...p, phase: "done", step: "running", done: [...STEP_ORDER] };
}
