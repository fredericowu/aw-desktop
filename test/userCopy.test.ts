import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_COPY, PHASE_LABEL, SUPERVISOR_COPY, failureCopy, lowDiskCopy } from "../src/shared/errorCopy";
import { STEP_LABEL } from "../src/shared/bootstrapState";
import { runPreflight } from "../src/main/preflightCore";

// ADR 0001: user-facing copy never names the engine, a VM, a container or an image.
const BANNED = /podman|\bVMs?\b|virtual machine|containers?|\bimages?\b|\bmachines?\b|\bengine\b|vfkit|gvproxy/i;

describe("user-facing wording", () => {
  const strings = [
    ...Object.values(FAILURE_COPY),
    ...Object.values(PHASE_LABEL),
    ...Object.values(SUPERVISOR_COPY),
    ...Object.values(STEP_LABEL),
    lowDiskCopy(),
    lowDiskCopy(12),
  ];
  it.each(strings.map((s) => [s]))("%s has no engine wording", (s) => {
    expect(s).not.toMatch(BANNED);
  });

  it("preflight reuses the shared copy", async () => {
    const r = await runPreflight({
      platform: "darwin", arch: "arm64", totalMemBytes: 16 * 1024 ** 3, freeDiskBytes: 1024 ** 3,
      homesRoot: "/Users/a/.awd", engineRuns: true, hypervisorSupported: async () => true,
    });
    expect(r.message).toBe(failureCopy("low_disk", 14));
  });

  it("all five ADR codes have copy", () => {
    for (const c of ["virtualization_unavailable", "low_disk", "low_memory", "download_failed", "start_failed"] as const) {
      expect(failureCopy(c, 3).length).toBeGreaterThan(10);
    }
  });

  // "Machine" is allowed only as "this Mac"-style hardware wording; renderer strings are scanned for the rest.
  const dir = join(__dirname, "../src/renderer/screens");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
    it(`${f} has no engine wording in string literals or JSX text`, () => {
      const src = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
        .filter((l) => !/import |data-testid|className|window\.aw\./.test(l) || /["'>].*(podman|\bVM\b)/i.test(l));
      const bad = src.filter((l) => /podman|\bVMs?\b|virtual machine|\bcontainers?\b|\bengine\b/i.test(l));
      expect(bad).toEqual([]);
    });
  }
});
