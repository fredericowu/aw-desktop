import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_IMAGE } from "../src/main/localRuntime";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();

describe("core pin", () => {
  it("scripts/core-ref equals WORKSPACE_IMAGE", () => {
    expect(read("scripts/core-ref")).toContain(`IMAGE=${WORKSPACE_IMAGE}\n`);
  });

  it("fetch-ui records the core image in build-info and the release gate runs before it", () => {
    expect(read("scripts/fetch-ui.sh")).toContain("coreImage");
    const wf = read(".github/workflows/release.yml");
    // One shared job, so both platforms act on the same decision and nothing is published before it.
    expect(wf.split("scripts/check-pins.sh").length - 1).toBe(1);
    expect(wf).toMatch(/release-macos:\n    needs: check-pins/);
    expect(wf).toContain("needs: [check-pins, release-macos]");
  });
});

describe("scripts/check-pins.sh", () => {
  function remotes() {
    const d = mkdtempSync(join(tmpdir(), "pins-"));
    const ui = join(d, "ui"), core = join(d, "core");
    for (const r of [ui, core]) { execFileSync("git", ["init", "-q", r]); git(r, "commit", "-q", "--allow-empty", "-m", "x"); }
    const uiHead = git(ui, "rev-parse", "HEAD");
    for (const t of ["v0.9.0", "v0.10.0", "v0.10.0-rc1"]) git(core, "tag", t);
    return { ui, core, uiHead, d };
  }
  // The script reads the repo's own ref files, so run a copy rooted in a temp dir.
  function sandbox(r: ReturnType<typeof remotes>, uiPin: string, coreTag: string) {
    const s = join(r.d, "desktop");
    execFileSync("mkdir", ["-p", join(s, "scripts")]);
    execFileSync("cp", [join(root, "scripts/check-pins.sh"), join(s, "scripts/")]);
    writeFileSync(join(s, "scripts/ui-ref"), uiPin + "\n");
    writeFileSync(join(s, "scripts/core-ref"), `IMAGE=ghcr.io/x/aw-workspace:${coreTag}\n`);
    return (env: Record<string, string> = {}) =>
      spawnSync("bash", [join(s, "scripts/check-pins.sh")], { env: { ...process.env, AW_UI_REMOTE: r.ui, AW_CORE_REMOTE: r.core, ...env }, encoding: "utf8" });
  }

  it("passes when both pins are current (numeric tag sort, rc ignored)", () => {
    const r = remotes();
    expect(sandbox(r, r.uiHead, "v0.10.0")().status).toBe(0);
  });
  it("fails on a stale ui-ref", () => {
    const r = remotes();
    const res = sandbox(r, "0".repeat(40), "v0.10.0")();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("ui-ref");
  });
  it("fails on a stale core-ref and passes with the override", () => {
    const r = remotes();
    const go = sandbox(r, r.uiHead, "v0.9.0");
    expect(go().status).toBe(1);
    expect(go().stderr).toContain("core-ref");
    expect(go({ ALLOW_STALE_PINS: "true" }).status).toBe(0);
  });
});
