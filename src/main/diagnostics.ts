import { appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { redact } from "../shared/bootstrapState";

/** Raw failure detail for support. Lives under userData; the renderer never receives it except via "Copy details". */
export const MAX_LOG_BYTES = 512 * 1024;
/** One entry is bounded so a single failure cannot blow the file limit. */
export const MAX_ENTRY_BYTES = 16 * 1024;
const READ_BYTES = 64 * 1024;
const COPY_ENTRIES = 3;

export interface DiagnosticEntry {
  context: string;
  code: string;
  raw: string;
  /** Account (sub) the failure belongs to; stored hashed. */
  account: string;
}

const acctTag = (account: string): string => createHash("sha256").update(account).digest("hex").slice(0, 12);

/** Strip credentials the app passes to the engine: KEY=value secrets, URL userinfo, app tokens. */
export function redactSecrets(s: string): string {
  return redact(s)
    .replace(/\b([A-Za-z0-9_]{0,40}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]{0,40})(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]")
    .replace(/([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]*:[^\s/@]*@/gi, "$1[redacted]@");
}

function bound(s: string): string {
  if (Buffer.byteLength(s) <= MAX_ENTRY_BYTES) return s;
  const half = Math.floor(MAX_ENTRY_BYTES / 2) - 16;
  return `${s.slice(0, half)}\n[... truncated ...]\n${s.slice(-half)}`;
}

function tryChmod(fn: () => void): void {
  try {
    fn();
  } catch {
    // Not supported (Windows) or not ours to change: never break the flow being logged.
  }
}

export function appendDiagnostic(file: string, e: DiagnosticEntry, now: Date = new Date()): void {
  try {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to a directory it creates; tighten a pre-existing one too (best effort).
    tryChmod(() => chmodSync(dir, 0o700));
    // Blank lines delimit entries, so squash them inside a body.
    // Bound before redacting so regex work is linear in a small input, then again after.
    const body = bound(redactSecrets(bound(e.raw)).trimEnd()).replace(/\n{2,}/g, "\n");
    const text = `[${now.toISOString()}] ${e.context} code=${e.code} acct=${acctTag(e.account)}\n${body}\n\n`;
    try {
      if (statSync(file).size + Buffer.byteLength(text) > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
        tryChmod(() => chmodSync(`${file}.1`, 0o600));
      }
    } catch {
      // No file yet.
    }
    // open()'s mode only applies when the file is created, so a pre-existing 0644 file would stay
    // readable by other local users. Enforce 0600 on every write.
    const fd = openSync(file, "a", 0o600);
    try {
      tryChmod(() => fchmodSync(fd, 0o600));
      appendFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Logging must never break the flow it describes.
  }
}

/** The most recent entries for this account only, reading just the end of the file. */
export function readDiagnosticTail(file: string, account: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, READ_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      let entries = buf.toString("utf8").split("\n\n").filter((x) => x.startsWith("["));
      // A tail read can start mid-entry: its header is gone, so it never starts with "[" and is dropped above.
      const tag = `acct=${acctTag(account)}`;
      entries = entries.filter((x) => x.split("\n", 1)[0].endsWith(tag));
      return entries.slice(-COPY_ENTRIES).join("\n\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
