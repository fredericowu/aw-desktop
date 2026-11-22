import { describe, expect, it } from "vitest";
import { runPreflight, MIN_FREE_DISK_BYTES, MIN_TOTAL_MEMORY_BYTES, type PreflightProbe } from "../src/main/preflightCore";

const GIB = 1024 ** 3;
const good = (over: Partial<PreflightProbe> = {}): PreflightProbe => ({
  platform: "darwin",
  arch: "arm64",
  totalMemBytes: 16 * GIB,
  freeDiskBytes: 100 * GIB,
  homesRoot: "/Users/frederico/.awd",
  engineBinExists: true,
  hypervisorSupported: async () => true,
  ...over,
});

describe("silent preflight", () => {
  it("passes on a capable Apple Silicon Mac", async () => {
    expect(await runPreflight(good())).toEqual({ ok: true });
  });

  it.each([
    ["Intel", { arch: "x64" }, "virtualization_unavailable"],
    ["non-mac", { platform: "linux" }, "virtualization_unavailable"],
    ["no hypervisor", { hypervisorSupported: async () => false }, "virtualization_unavailable"],
    ["hypervisor query throws", { hypervisorSupported: async () => { throw new Error("x"); } }, "virtualization_unavailable"],
    ["low memory", { totalMemBytes: MIN_TOTAL_MEMORY_BYTES - 1 }, "low_memory"],
    ["low disk", { freeDiskBytes: MIN_FREE_DISK_BYTES - 1 }, "low_disk"],
    ["engine missing", { engineBinExists: false }, "engine_missing"],
    ["socket path too long", { homesRoot: "/Users/" + "a".repeat(60) + "/.awd" }, "path_too_long"],
  ] as const)("%s refuses with code %s", async (_n, over, code) => {
    const r = await runPreflight(good(over as Partial<PreflightProbe>));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
  });

  it("never attempts the hypervisor query when a cheaper check already failed", async () => {
    let called = false;
    await runPreflight(good({ freeDiskBytes: 0, hypervisorSupported: async () => { called = true; return true; } }));
    expect(called).toBe(false);
  });

  it("low-disk copy names how much to free", async () => {
    const r = await runPreflight(good({ freeDiskBytes: 11 * GIB }));
    expect(r.message).toBe("Not enough free disk space. Free up 4 GB and try again.");
  });

  it("no user-facing message mentions the engine, a VM, a container or an image", async () => {
    const cases: Partial<PreflightProbe>[] = [
      { arch: "x64" }, { totalMemBytes: 0 }, { freeDiskBytes: 0 }, { engineBinExists: false }, { homesRoot: "/Users/" + "a".repeat(80) },
    ];
    for (const c of cases) {
      const r = await runPreflight(good(c));
      expect(r.message).not.toMatch(/podman|\bvm\b|virtual machine|container|image|engine/i);
    }
  });
});
