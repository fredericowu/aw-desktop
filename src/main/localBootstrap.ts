/** Single-flight / session helpers shared by the local-workspace setup flow. */

/** Single-flight slot for "a setup is running on this Mac". */
export class SetupSlot {
  private busy = false;
  claim(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  release(): void {
    this.busy = false;
  }
  get isBusy(): boolean {
    return this.busy;
  }
}

/** Claims the slot SYNCHRONOUSLY (before any await), runs `work`, and releases
 * on every exit unless `work` called `handOff()` (the background bootstrap then
 * owns the slot and must release it). Two rapid calls can never both pass. */
export async function exclusive<T>(slot: SetupSlot, busy: T, work: (handOff: () => void) => Promise<T>): Promise<T> {
  if (!slot.claim()) return busy;
  let handedOff = false;
  try {
    return await work(() => {
      handedOff = true;
    });
  } finally {
    if (!handedOff) slot.release();
  }
}

/** Ties a setup job to the sign-in session that started it. `end()` (sign-out)
 * invalidates every job begun before it: they stop emitting, lose token access,
 * abort their poll and must not auto-open a workspace for whoever signs in next. */
export interface SessionHandle {
  isCurrent(): boolean;
  signal: AbortSignal;
  finish(): void;
}

export class SessionScope {
  private epoch = 0;
  private jobs = new Set<AbortController>();
  begin(): SessionHandle {
    const epoch = this.epoch;
    const ac = new AbortController();
    this.jobs.add(ac);
    return {
      isCurrent: () => epoch === this.epoch,
      signal: ac.signal,
      finish: () => void this.jobs.delete(ac),
    };
  }
  end(): void {
    this.epoch++;
    for (const ac of this.jobs) ac.abort();
    this.jobs.clear();
  }
}

/** `exclusive` + a session handle begun SYNCHRONOUSLY at entry (before any
 * await), so work that outlives a sign-out/sign-in is judged against the
 * session that asked for it. The handle is finished unless `handOff()` ran. */
export function scopedExclusive<T>(
  slot: SetupSlot,
  scope: SessionScope,
  busy: T,
  work: (session: SessionHandle, handOff: () => void) => Promise<T>,
): Promise<T> {
  return exclusive(slot, busy, async (slotHandOff) => {
    const session = scope.begin();
    let started = false;
    try {
      return await work(session, () => {
        started = true;
        slotHandOff();
      });
    } finally {
      if (!started) session.finish();
    }
  });
}

/** Runs `open` only if the session that asked for it is still current, checked
 * AGAIN after the async prepare step (cookie write): sign-out can land in that
 * window. When it did, `undo` removes what prepare wrote. */
export async function openIfCurrent(isCurrent: () => boolean, prepare: () => Promise<void>, open: () => void, undo: () => void): Promise<boolean> {
  if (!isCurrent()) return false;
  await prepare();
  if (!isCurrent()) {
    undo();
    return false;
  }
  open();
  return true;
}

export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Download with a hard deadline covering the body read: a release response
 * that trickles bytes forever must fail (so Retry is offered) rather than
 * hold the setup slot until Desktop restarts. */
export async function fetchBytes(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<Uint8Array> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (timedOut) throw new Error(`download timed out for ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
