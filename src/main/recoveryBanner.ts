// Recovery banner (VM-5 rework): while a local workspace is open, supervisor status must be visible
// INSIDE the workspace window, not only in the hidden picker. No electron imports: the view and the
// retry action are injected, so the state machine is unit-testable.
import { SUPERVISOR_COPY } from "../shared/errorCopy";
import type { SupervisedStatus } from "./supervisorCore";

export type BannerState = { kind: "hidden" } | { kind: "recovering"; text: string } | { kind: "attention"; title: string; text: string; canRetry: boolean };

export const BANNER_HIDDEN: BannerState = { kind: "hidden" };

export const BANNER_COPY = {
  recovering: SUPERVISOR_COPY.starting,
  attentionTitle: "Needs attention",
  attention: "We couldn't restart this workspace. Try again.",
  retry: "Retry",
  retrying: SUPERVISOR_COPY.starting,
} as const;

/** Pure mapping from supervisor status. `running` and unwatched (null) dismiss the banner. */
export function bannerFor(status: SupervisedStatus | null, retrying = false): BannerState {
  if (status === "starting" || retrying) return { kind: "recovering", text: BANNER_COPY.recovering };
  if (status === "needs_attention") return { kind: "attention", title: BANNER_COPY.attentionTitle, text: BANNER_COPY.attention, canRetry: true };
  return BANNER_HIDDEN;
}

export interface BannerView {
  render(state: BannerState): void;
}

export interface BannerDeps {
  view: BannerView;
  /** Current supervisor status of a workspace, used when a window opens mid-recovery. */
  statusOf(id: string): SupervisedStatus | null;
  /** Retry in recovery mode inside the setup slot. Resolves false when it could not run (slot busy, failed). */
  retry(id: string): Promise<boolean>;
}

/** Follows the one open local workspace; ignores every other workspace's status. */
export class RecoveryBanner {
  private openId: string | null = null;
  private retrying = false;
  private current: BannerState = BANNER_HIDDEN;

  constructor(private readonly deps: BannerDeps) {}

  state(): BannerState {
    return this.current;
  }

  private set(next: BannerState): void {
    if (next.kind === this.current.kind && JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.deps.view.render(next);
  }

  /** A local workspace window opened (id) or closed (null). Syncs with the status it opens into. */
  setOpen(id: string | null): void {
    this.openId = id;
    this.retrying = false;
    this.set(id ? bannerFor(this.deps.statusOf(id)) : BANNER_HIDDEN);
  }

  /** Supervisor status change for any workspace; only the open one drives the banner. */
  onStatus(id: string, status: SupervisedStatus | null): void {
    if (id !== this.openId) return;
    if (status !== "needs_attention") this.retrying = this.retrying && status === "starting";
    this.set(bannerFor(status, this.retrying));
  }

  /** The Retry button. Shows progress at once; on failure returns to "needs attention" so Retry stays available. */
  async retry(): Promise<void> {
    const id = this.openId;
    if (!id || this.current.kind !== "attention" || this.retrying) return;
    this.retrying = true;
    this.set(bannerFor(this.deps.statusOf(id), true));
    try {
      await this.deps.retry(id);
    } catch {
      // Falls through: the status below decides what the banner shows.
    }
    if (this.openId !== id) return;
    this.retrying = false;
    this.set(bannerFor(this.deps.statusOf(id)));
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Self-contained page for the banner view. Plain copy only; Retry goes through the banner preload. */
export function bannerHtml(state: BannerState): string {
  if (state.kind === "hidden") return "<!doctype html><html><body></body></html>";
  const button = state.kind === "attention" && state.canRetry ? `<button id="r" onclick="window.awBanner.retry()">${esc(BANNER_COPY.retry)}</button>` : "";
  const spinner = state.kind === "recovering" ? `<span class="spin" role="progressbar" aria-label="${esc(state.text)}"></span>` : "";
  const heading = state.kind === "attention" ? `<b>${esc(state.title)}</b> ` : "";
  const bg = state.kind === "attention" ? "#7a2e0e" : "#1f3a5f";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;font:13px -apple-system,system-ui,sans-serif;color:#fff;background:${bg}}body{display:flex;align-items:center;justify-content:center;gap:12px}.spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:s 0.9s linear infinite}@keyframes s{to{transform:rotate(360deg)}}b{font-weight:600}button{font:inherit;padding:3px 12px;border-radius:6px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer}</style></head><body>${spinner}<span role="status">${heading}${esc(state.text)}</span>${button}</body></html>`;
}
