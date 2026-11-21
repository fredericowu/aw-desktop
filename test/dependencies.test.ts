import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DepInstaller, PODMAN_PKG_SHA256, buildSnapshot, plansFor, verifySha256, type DepProbe, type InstallOps } from "../src/main/dependencies";

const mac = { platform: "darwin", arch: "arm64" };
const none: DepProbe = { podman: false };

function mk(ops: Partial<InstallOps> = {}) {
  const persisted: Array<string | null> = [];
  const changes = vi.fn();
  const full: InstallOps = {
    download: vi.fn(async (_u, p) => { p(50); return new Uint8Array([1, 2, 3]); }),
    unpackPodmanPkg: vi.fn(async () => undefined),
    ...ops,
  };
  const inst = new DepInstaller({ ops: full, env: mac, persist: (m) => persisted.push(m), onChange: changes });
  return { inst, full, persisted, changes };
}

describe("buildSnapshot", () => {
  it("all missing: not ready; machine is optional", () => {
    const s = buildSnapshot(mac, none, {});
    expect(s.items.map((i) => [i.id, i.state])).toEqual([["podman", "missing"], ["machine", "missing"]]);
    expect(s.ready).toBe(false);
    expect(s.items.find((i) => i.id === "machine")!.required).toBe(false);
  });
  it("ready only when every REQUIRED item is installed (machine not needed)", () => {
    expect(buildSnapshot(mac, { podman: true }, {}).ready).toBe(true);
    expect(buildSnapshot(mac, { podman: false }, {}).ready).toBe(false);
  });
  it("probe wins over a stale live state; live state shows while not installed", () => {
    const live = { podman: { state: "installing" as const, progress: 30 } };
    expect(buildSnapshot(mac, none, live).items[0]).toMatchObject({ state: "installing", progress: 30 });
    expect(buildSnapshot(mac, { ...none, podman: true }, live).items[0].state).toBe("installed");
  });
  it("shows url, size and checksum before any install (plan), and pins the podman sha", () => {
    const p = plansFor(mac).podman!;
    expect(p.source).toMatch(/^https:\/\/github\.com\/containers\/podman\/releases\/download\/v[\d.]+\/.*arm64\.pkg$/);
    expect(p.checksum).toContain(PODMAN_PKG_SHA256.arm64);
    expect(p.needsAdmin).toBe(false);
  });
  it("Intel and Windows: unsupported, no plan, never ready", () => {
    for (const env of [{ platform: "darwin", arch: "x64" }, { platform: "win32", arch: "x64" }]) {
      const s = buildSnapshot(env, none, {});
      expect(s.supported).toBe(false);
      expect(s.items.every((i) => !i.plan)).toBe(true);
      expect(s.ready).toBe(false);
    }
  });
});

describe("verifySha256", () => {
  const data = new Uint8Array([9, 9, 9]);
  const good = createHash("sha256").update(data).digest("hex");
  it("passes on match, throws on mismatch", () => {
    expect(() => verifySha256(data, good, "x")).not.toThrow();
    expect(() => verifySha256(data, "0".repeat(64), "x")).toThrow(/checksum mismatch/);
  });
});

describe("DepInstaller", () => {
  it("refuses without explicit approval and does nothing", async () => {
    const { inst, full } = mk();
    expect(await inst.install("podman", false, none)).toMatchObject({ ok: false });
    expect(full.download).not.toHaveBeenCalled();
  });
  it("a podman download that fails its checksum is rejected, never unpacked, and shows failed", async () => {
    const { inst, full } = mk();
    const r = await inst.install("podman", true, none);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum mismatch/);
    expect(full.unpackPodmanPkg).not.toHaveBeenCalled();
    expect(inst.live.podman).toMatchObject({ state: "failed" });
  });
  it("a matching download is unpacked, state cleared, marker persisted then cleared", async () => {
    const bytes = new Uint8Array([7, 7]);
    const orig = PODMAN_PKG_SHA256.arm64;
    PODMAN_PKG_SHA256.arm64 = createHash("sha256").update(bytes).digest("hex");
    try {
      const { inst, full, persisted } = mk({ download: vi.fn(async () => bytes) });
      expect(await inst.install("podman", true, none)).toEqual({ ok: true });
      expect(full.unpackPodmanPkg).toHaveBeenCalledWith(bytes);
      expect(inst.live.podman).toBeUndefined();
      expect(persisted).toEqual(["podman", null]);
    } finally {
      PODMAN_PKG_SHA256.arm64 = orig;
    }
  });
  it("installing reports progress then single-flights a second install", async () => {
    let release!: () => void;
    const { inst, changes } = mk({
      download: vi.fn((_u, p) => new Promise<Uint8Array>((r) => { p(40); release = () => r(new Uint8Array([1])); })),
      unpackPodmanPkg: vi.fn(async () => undefined),
    });
    const orig = PODMAN_PKG_SHA256.arm64;
    PODMAN_PKG_SHA256.arm64 = createHash("sha256").update(new Uint8Array([1])).digest("hex");
    try {
      const first = inst.install("podman", true, none);
      expect(inst.live.podman).toMatchObject({ state: "installing", progress: 40 });
      expect(await inst.install("podman", true, none)).toMatchObject({ ok: false, error: expect.stringMatching(/running/) });
      release();
      expect(await first).toEqual({ ok: true });
      expect(inst.active).toBeNull();
      expect(changes).toHaveBeenCalled();
    } finally {
      PODMAN_PKG_SHA256.arm64 = orig;
    }
  });
  it("a failed install can be retried (failed -> installing -> installed)", async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(new Uint8Array([1]));
    const { inst } = mk({ download });
    const orig = PODMAN_PKG_SHA256.arm64;
    PODMAN_PKG_SHA256.arm64 = createHash("sha256").update(new Uint8Array([1])).digest("hex");
    try {
      expect((await inst.install("podman", true, none)).ok).toBe(false);
      expect(inst.live.podman).toMatchObject({ state: "failed", error: "network" });
      expect(await inst.install("podman", true, none)).toEqual({ ok: true });
      expect(inst.live.podman).toBeUndefined();
    } finally {
      PODMAN_PKG_SHA256.arm64 = orig;
    }
  });
  it("already installed: no-op; machine has no plan", async () => {
    const { inst, full } = mk();
    expect(await inst.install("podman", true, { podman: true })).toEqual({ ok: true });
    expect(full.download).not.toHaveBeenCalled();
    expect((await inst.install("machine", true, none)).ok).toBe(false);
  });
});
