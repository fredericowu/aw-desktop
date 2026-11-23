import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_BYTES, MAX_LOG_BYTES, appendDiagnostic, readDiagnosticTail } from "../src/main/diagnostics";

const tmp = () => join(mkdtempSync(join(tmpdir(), "awd-diag-")), "sub", "diagnostics.log");

describe("diagnostics log", () => {
  it("writes raw detail with context, code and timestamp, redacting tokens", () => {
    const f = tmp();
    appendDiagnostic(f, { context: "start_local", code: "start_failed", raw: "podman failed token awlk_SECRET123 x", account: "a" }, new Date("2026-01-02T03:04:05Z"));
    const s = readFileSync(f, "utf8");
    expect(s).toContain("[2026-01-02T03:04:05.000Z] start_local code=start_failed");
    expect(s).toContain("podman failed");
    expect(s).not.toContain("SECRET123");
  });

  it("redacts database credentials from engine commands and URLs", () => {
    const f = tmp();
    appendDiagnostic(f, {
      context: "c", code: "start_failed", account: "a",
      raw: "Command failed: podman run -e POSTGRES_PASSWORD=hunter2pw -e FOO=bar postgres\nDATABASE_URL=postgresql://aw:hunter2pw@db:5432/aw api_key: abc123",
    });
    const s = readFileSync(f, "utf8");
    expect(s).not.toContain("hunter2pw");
    expect(s).not.toContain("abc123");
    expect(s).toContain("FOO=bar");
  });

  it("a single huge entry is bounded and the file stays under the limit", () => {
    const f = tmp();
    appendDiagnostic(f, { context: "a", code: "x", account: "a", raw: "y".repeat(1024 * 1024) });
    expect(statSync(f).size).toBeLessThan(MAX_ENTRY_BYTES + 512);
    for (let i = 0; i < 100; i++) appendDiagnostic(f, { context: "a", code: "x", account: "a", raw: "z".repeat(MAX_ENTRY_BYTES) });
    expect(statSync(f).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(existsSync(`${f}.1`)).toBe(true);
  });

  it("Copy details returns only the active account's recent entries", () => {
    const f = tmp();
    appendDiagnostic(f, { context: "a", code: "x", account: "alice", raw: "alice-failure" });
    appendDiagnostic(f, { context: "b", code: "y", account: "bob", raw: "bob-failure" });
    const bob = readDiagnosticTail(f, "bob");
    expect(bob).toContain("bob-failure");
    expect(bob).not.toContain("alice-failure");
    expect(readDiagnosticTail(f, "carol")).toBe("");
  });

  it("tail read is bounded for a large file", () => {
    const f = tmp();
    for (let i = 0; i < 20; i++) appendDiagnostic(f, { context: "a", code: "x", account: "a", raw: `n${i}-` + "q".repeat(MAX_ENTRY_BYTES - 100) });
    const t = readDiagnosticTail(f, "a");
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(64 * 1024);
    expect(t).toContain("n19-");
  });

  it("tail is empty when there is no log and never throws", () => {
    expect(readDiagnosticTail("/nonexistent/dir/diagnostics.log", "a")).toBe("");
    expect(() => appendDiagnostic("/proc/nope/x.log", { context: "c", code: "d", raw: "e", account: "a" })).not.toThrow();
  });

  // POSIX modes only; Windows has no chmod semantics.
  const posix = process.platform === "win32" ? it.skip : it;
  const mode = (p: string) => statSync(p).mode & 0o777;

  posix("a new log is created 0600", () => {
    const f = tmp();
    appendDiagnostic(f, { context: "c", code: "d", raw: "e", account: "a" });
    expect(mode(f)).toBe(0o600);
  });

  posix("a pre-existing 0644 log is tightened to 0600 on write, content preserved", () => {
    const f = tmp();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "[old] entry\n\n");
    chmodSync(f, 0o644);
    appendDiagnostic(f, { context: "c", code: "d", raw: "new-detail", account: "a" });
    expect(mode(f)).toBe(0o600);
    const s = readFileSync(f, "utf8");
    expect(s).toContain("[old] entry");
    expect(s).toContain("new-detail");
  });

  posix("a pre-existing 0755 parent dir is tightened to 0700", () => {
    const f = tmp();
    mkdirSync(dirname(f), { recursive: true });
    chmodSync(dirname(f), 0o755);
    appendDiagnostic(f, { context: "c", code: "d", raw: "e", account: "a" });
    expect(mode(dirname(f))).toBe(0o700);
  });

  posix("a rotated .1 file from a 0644 log is also 0600", () => {
    const f = tmp();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "x".repeat(MAX_LOG_BYTES - 10));
    chmodSync(f, 0o644);
    appendDiagnostic(f, { context: "c", code: "d", raw: "e", account: "a" });
    expect(mode(`${f}.1`)).toBe(0o600);
    expect(mode(f)).toBe(0o600);
  });
});
