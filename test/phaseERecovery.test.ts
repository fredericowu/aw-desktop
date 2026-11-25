import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM harness module, no type declarations
import { MODES, SECRET, prepareEngine, shimScript } from "../e2e/phaseE/shim.mjs";

describe("phaseE recovery shim", () => {
  it("emits one failure per mode, each carrying its RAWMARK token", () => {
    const s = shimScript("/w");
    for (const m of MODES.filter((x: string) => x !== "pass" && x !== "slowstart")) expect(s).toContain(`RAWMARK-${m}`);
    expect(s).toContain(SECRET);
    expect(s).toContain('exec "$(dirname "$0")/podman.real"');
  });
  it("quotes the work dir", () => {
    expect(shimScript("/a b/it's")).toContain(`D='/a b/it'\\''s'`);
  });
  it("copies the engine, installs the shim over podman and keeps the original as podman.real; never in place", () => {
    const root = mkdtempSync(join(tmpdir(), "phasee-shim-"));
    const src = join(root, "src"), dest = join(root, "dest"), work = join(root, "work");
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin/podman"), "#!/bin/sh\necho real \"$@\"\n", { mode: 0o755 });
    expect(() => prepareEngine(src, src, work)).toThrow(/in place/);
    const { real } = prepareEngine(src, dest, work);
    expect(readFileSync(real, "utf8")).toContain("echo real");
    expect(readFileSync(join(src, "bin/podman"), "utf8")).toContain("echo real"); // installed engine untouched
    expect(statSync(join(dest, "bin/podman")).mode & 0o111).not.toBe(0);
    prepareEngine(src, dest, work); // idempotent: shim rewritten, real binary not overwritten by the shim
    expect(readFileSync(real, "utf8")).toContain("echo real");
    // behaviour: pass mode forwards and logs; startfail fails only `machine start`
    const run = (...a: string[]) => { try { return { code: 0, out: execFileSync(join(dest, "bin/podman"), a, { stdio: "pipe" }).toString() }; } catch (e) { const x = e as { status: number; stderr: Buffer }; return { code: x.status, out: x.stderr.toString() }; } };
    expect(run("ps")).toEqual({ code: 0, out: "real ps\n" });
    writeFileSync(join(work, "mode"), "startfail");
    expect(run("ps").code).toBe(0);
    const f = run("machine", "start", "aw-x");
    expect(f.code).toBe(125);
    expect(f.out).toContain("RAWMARK-startfail");
    expect(existsSync(join(work, "calls.log"))).toBe(true);
    expect(readFileSync(join(work, "calls.log"), "utf8")).toMatch(/machine start aw-x/);
  });
});
