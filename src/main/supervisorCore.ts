// Lifecycle supervisor (ADR 0001, decision 3). No electron imports: every effect is injected, so the
// failure paths are unit-testable. It watches only workspaces the app brought up; a workspace the user
// stopped (or removed) is unwatched and is never restarted by this code.

export type SupervisedStatus = "running" | "starting" | "needs_attention";

/** Outcome of one recovery attempt. "busy" means the setup slot was taken: not counted as an attempt. */
export type RecoverOutcome = "ok" | "busy";

export interface SupervisorDeps {
  /** True when GET /api/health answers 200. Must not throw; a failure to answer is false. */
  healthy(id: string): Promise<boolean>;
  /** Re-run start in recovery mode inside the setup slot. Throws when recovery fails. */
  recover(id: string): Promise<RecoverOutcome>;
  onStatus(id: string, status: SupervisedStatus): void;
  /** Raw failure for the diagnostics log. */
  onFailure(id: string, err: unknown): void;
  now?: () => number;
}

export interface SupervisorOptions {
  /** Health failures in a row before recovery starts (one dropped poll is not an outage). */
  failThreshold?: number;
  /** Recovery attempts before "needs attention". */
  maxAttempts?: number;
  /** Wait before attempt n+1 after attempt n failed. Last entry repeats. */
  backoffMs?: number[];
}

interface Entry {
  status: SupervisedStatus;
  misses: number;
  attempts: number;
  /** Earliest time the next recovery attempt may run. */
  notBefore: number;
  inFlight: boolean;
}

export class Supervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly maxAttempts: number;
  private readonly backoff: number[];
  private readonly clock: () => number;

  constructor(private readonly deps: SupervisorDeps, opts: SupervisorOptions = {}) {
    this.threshold = opts.failThreshold ?? 2;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoff = opts.backoffMs ?? [5_000, 15_000, 45_000];
    this.clock = deps.now ?? Date.now;
  }

  /** Start watching (after a successful start). Resets any earlier failure state. */
  watch(id: string): void {
    this.entries.set(id, { status: "running", misses: 0, attempts: 0, notBefore: 0, inFlight: false });
  }

  /** Stop watching: the user stopped or removed it, or the app is quitting. Never restarts it afterwards. */
  unwatch(id: string): void {
    this.entries.delete(id);
  }

  unwatchAll(): void {
    this.entries.clear();
  }

  watching(id: string): boolean {
    return this.entries.has(id);
  }

  status(id: string): SupervisedStatus | null {
    return this.entries.get(id)?.status ?? null;
  }

  private setStatus(id: string, e: Entry, status: SupervisedStatus): void {
    if (e.status === status) return;
    e.status = status;
    this.deps.onStatus(id, status);
  }

  /** One pass over every watched workspace. Safe to call from a timer, a wake hook or a test. */
  async tick(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.check(id)));
  }

  private async check(id: string): Promise<void> {
    const e = this.entries.get(id);
    // needs_attention stays put until the user retries (which calls watch() again).
    if (!e || e.inFlight || e.status === "needs_attention") return;
    e.inFlight = true;
    try {
      const ok = await this.deps.healthy(id);
      // The user may have stopped it while the probe was in the air.
      if (this.entries.get(id) !== e) return;
      if (ok) {
        e.misses = 0;
        e.attempts = 0;
        this.setStatus(id, e, "running");
        return;
      }
      e.misses++;
      if (e.misses < this.threshold) return;
      if (this.clock() < e.notBefore) return; // backing off after a failed attempt
      this.setStatus(id, e, "starting");
      let outcome: RecoverOutcome;
      try {
        outcome = await this.deps.recover(id);
      } catch (err) {
        if (this.entries.get(id) !== e) return;
        e.attempts++;
        this.deps.onFailure(id, err);
        if (e.attempts >= this.maxAttempts) {
          this.setStatus(id, e, "needs_attention");
        } else {
          e.notBefore = this.clock() + this.backoff[Math.min(e.attempts - 1, this.backoff.length - 1)];
        }
        return;
      }
      if (this.entries.get(id) !== e) return;
      if (outcome === "ok") {
        e.misses = 0;
        e.attempts = 0;
        e.notBefore = 0;
        this.setStatus(id, e, "running");
      }
      // "busy": try again next tick, no attempt consumed.
    } finally {
      e.inFlight = false;
    }
  }
}
