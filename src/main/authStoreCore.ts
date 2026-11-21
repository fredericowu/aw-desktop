import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
 * OS raises a modal "Keychain Not Found" on EVERY call. So:
 *  - safeStorage is only touched when there is something to read or write
 *    (never unconditionally at launch);
 *  - an "attempt" marker is persisted BEFORE the first call and removed after
 *    it returns, so a call that blocks or kills the process is treated as a
 *    failure on the next launch (safeStorage is a synchronous native call and
 *    cannot be timed out in-process);
 *  - any failure/cancel persists a "disabled" flag: safeStorage is never
 *    called again, this run or any future one;
 *  - the token then lives in a 0600 file in userData. */
export class AuthStore {
  private inMemoryDisabled = false;

  constructor(
    private readonly dir: () => string,
    private readonly storage: () => SafeStorageLike,
  ) {}

  private p(name: string): string {
    const d = this.dir();
    mkdirSync(d, { recursive: true });
    return join(d, name);
  }

  private get encPath() { return this.p("session.bin"); }
  private get plainPath() { return this.p("session.json"); }
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
    try { writeFileSync(this.flagPath, String(Date.now()), { mode: 0o600 }); } catch { /* best effort */ }
    try { unlinkSync(this.attemptPath); } catch { /* ignore */ }
  }

  /** Run one guarded safeStorage operation. Returns null on any failure. */
  private guarded<T>(op: (s: SafeStorageLike) => T): T | null {
    if (this.isDisabled()) return null;
    try {
      writeFileSync(this.attemptPath, String(Date.now()), { mode: 0o600 });
    } catch {
      this.inMemoryDisabled = true;
      return null;
    }
    try {
      const s = this.storage();
      if (!s.isEncryptionAvailable()) throw new Error("encryption unavailable");
      const out = op(s);
      try { unlinkSync(this.attemptPath); } catch { /* ignore */ }
      return out;
    } catch {
      this.disable();
      return null;
    }
  }

  private writePlain(token: string): void {
    const path = this.plainPath;
    writeFileSync(path, token, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  load(): string | null {
    if (existsSync(this.plainPath)) {
      try { return readFileSync(this.plainPath, "utf8") || null; } catch { return null; }
    }
    if (!existsSync(this.encPath)) return null;
    return this.guarded((s) => s.decryptString(readFileSync(this.encPath)));
  }

  save(token: string): void {
    const enc = this.guarded((s) => s.encryptString(token));
    if (enc) {
      writeFileSync(this.encPath, enc);
      try { unlinkSync(this.plainPath); } catch { /* ignore */ }
      return;
    }
    this.writePlain(token);
    try { unlinkSync(this.encPath); } catch { /* ignore */ }
  }

  clear(): void {
    for (const f of [this.encPath, this.plainPath]) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

