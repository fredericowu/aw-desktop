import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "../shared/bootstrapState";

/** Raw failure detail for support. Lives under userData; the renderer never receives it except via "Copy details". */
export const MAX_LOG_BYTES = 512 * 1024;
const TAIL_BYTES = 32 * 1024;

export interface DiagnosticEntry {
  context: string;
  code: string;
  raw: string;
}

export function appendDiagnostic(file: string, e: DiagnosticEntry, now: Date = new Date()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No file yet.
    }
    const body = redact(e.raw).trimEnd();
    appendFileSync(file, `[${now.toISOString()}] ${e.context} code=${e.code}\n${body}\n\n`, { mode: 0o600 });
  } catch {
    // Logging must never break the flow it describes.
  }
}

/** The recent end of the log, for the "Copy details" button. */
export function readDiagnosticTail(file: string): string {
  try {
    const s = readFileSync(file, "utf8");
    return s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s;
  } catch {
    return "";
  }
}
