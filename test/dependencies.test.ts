import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DepInstaller, buildSnapshot, plansFor, verifySha256, type DepProbe, type InstallOps } from "../src/main/dependencies";

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
  it("the engine is bundled: a missing binary gets reinstall guidance and no download plan", () => {
    expect(plansFor(mac).podman).toBeUndefined();
    const row = buildSnapshot(mac, none, {}).items[0];
    expect(row).toMatchObject({ id: "podman", state: "missing" });
    expect(row.plan).toBeUndefined();
    expect(row.note).toMatch(/Reinstall AW Desktop/);
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
  it("never downloads or unpacks a package: the engine ships inside the app", async () => {
    const { inst, full, persisted } = mk();
    expect(await inst.install("podman", true, none)).toMatchObject({ ok: false });
    expect(await inst.install("podman", false, none)).toMatchObject({ ok: false });
    expect(full.download).not.toHaveBeenCalled();
    expect(full.unpackPodmanPkg).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
  });
  it("already installed: no-op; machine has no plan", async () => {
    const { inst, full } = mk();
    expect((await inst.install("machine", true, none)).ok).toBe(false);
    expect(full.download).not.toHaveBeenCalled();
  });
});
