import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The slice of Electron safeStorage we use (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

/** Raw aw_id_jwt storage.
 *
 * safeStorage on macOS touches the login keychain; with no default keychain the
 * OS raises a modal "Keychain Not Found" / "enter password" dialog on EVERY
 * call. So the Keychain is touched at most once per app run:
 *  - safeStorage is only touched when there is something to read or write
 *    (never unconditionally at launch);
 *  - availability is probed once and memoized; later ops reuse the result;
 *  - all calls are synchronous (JS is single-threaded), so concurrent callers
 *    are serialized and share that one probe;
 *  - any failure latches "failed" for the rest of the run (no retry, no
 *    repeated prompts) and persists a "disabled" flag so future launches skip
 *    safeStorage too. An "attempt" marker written BEFORE the first call turns
 *    a hang/kill into a failure on the next launch;
 *  - on failure the token lives in memory only: the user is signed out on the
 *    next launch ("sign in again"). Nothing is written in plaintext. */
export class AuthStore {
  private inMemoryDisabled = false;
  /** Memoized safeStorage availability probe: undefined = not probed yet. */
  private available: boolean | undefined;
  private memToken: string | null = null;
  private logged = false;

  constructor(
    private readonly dir: () => string,
    private readonly storage: () => SafeStorageLike,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  private p(name: string): string {
    const d = this.dir();
    mkdirSync(d, { recursive: true });
    return join(d, name);
  }

  private get encPath() { return this.p("session.bin"); }
  private get legacyPlainPath() { return this.p("session.json"); }
  private get flagPath() { return this.p("safestorage-disabled"); }
  private get attemptPath() { return this.p("safestorage-attempt"); }

  /** True once safeStorage must not be called any more. */
  isDisabled(): boolean {
    if (this.inMemoryDisabled) return true;
    // A leftover attempt marker means the last call never returned (hang/kill).
    if (existsSync(this.flagPath) || existsSync(this.attemptPath)) {
      this.disable();
      return true;
    }
    return false;
  }

  private disable(): void {
    this.inMemoryDisabled = true;
    if (!this.logged) {
      this.logged = true;
      this.log("auth: Keychain unavailable; session kept in memory only (sign in again next launch)");
    }
    try { writeFileSync(this.flagPath, String(Date.now()), { mode: 0o600 }); } catch { /* best effort */ }
    try { unlinkSync(this.attemptPath); } catch { /* ignore */ }
  }

  /** Run one guarded safeStorage operation. Returns null on any failure. */
  private guarded<T>(op: (s: SafeStorageLike) => T): T | null {
    if (this.isDisabled()) return null;
    const first = this.available === undefined;
    if (first) {
      try {
        writeFileSync(this.attemptPath, String(Date.now()), { mode: 0o600 });
      } catch {
        this.inMemoryDisabled = true;
        return null;
      }
    }
    try {
      const s = this.storage();
      if (first) {
        this.available = s.isEncryptionAvailable();
        if (!this.available) throw new Error("encryption unavailable");
      }
      const out = op(s);
      if (first) { try { unlinkSync(this.attemptPath); } catch { /* ignore */ } }
      return out;
    } catch {
      this.disable();
      return null;
    }
  }

  load(): string | null {
    if (this.memToken) return this.memToken;
    // Legacy v0.1.10 plaintext fallback: never read, remove it.
    try { unlinkSync(this.legacyPlainPath); } catch { /* ignore */ }
    if (!existsSync(this.encPath)) return null;
    const t = this.guarded((s) => s.decryptString(readFileSync(this.encPath)));
    if (t) this.memToken = t;
    return t;
  }

  save(token: string): void {
    this.memToken = token;
    const enc = this.guarded((s) => s.encryptString(token));
    if (enc) {
      writeFileSync(this.encPath, enc);
      return;
    }
    try { unlinkSync(this.encPath); } catch { /* ignore */ }
  }

  clear(): void {
    this.memToken = null;
    for (const f of [this.encPath, this.legacyPlainPath]) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
