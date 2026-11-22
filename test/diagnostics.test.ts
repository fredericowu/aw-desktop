import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_LOG_BYTES, appendDiagnostic, readDiagnosticTail } from "../src/main/diagnostics";

const tmp = () => join(mkdtempSync(join(tmpdir(), "awd-diag-")), "sub", "diagnostics.log");

describe("diagnostics log", () => {
  it("writes raw detail with context, code and timestamp, redacting tokens", () => {
    const f = tmp();
    appendDiagnostic(f, { context: "start_local", code: "start_failed", raw: "podman failed token awlk_SECRET123 x" }, new Date("2026-01-02T03:04:05Z"));
    const s = readFileSync(f, "utf8");
    expect(s).toContain("[2026-01-02T03:04:05.000Z] start_local code=start_failed");
    expect(s).toContain("podman failed");
    expect(s).not.toContain("SECRET123");
  });

  it("rotates once past the size cap", () => {
    const f = tmp();
    appendDiagnostic(f, { context: "a", code: "x", raw: "first" });
    writeFileSync(f, "x".repeat(MAX_LOG_BYTES + 1));
    appendDiagnostic(f, { context: "b", code: "y", raw: "second" });
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(readFileSync(f, "utf8")).toContain("second");
    expect(readFileSync(f, "utf8")).not.toContain("xxxx");
  });

  it("tail is empty when there is no log and never throws", () => {
    expect(readDiagnosticTail("/nonexistent/dir/diagnostics.log")).toBe("");
    expect(() => appendDiagnostic("/proc/nope/x.log", { context: "c", code: "d", raw: "e" })).not.toThrow();
  });
});
