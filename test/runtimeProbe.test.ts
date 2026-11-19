import { describe, expect, it } from "vitest";
import { candidatePaths, probeRuntimes, type ProbeDeps } from "../src/main/runtimeProbe";

function deps(existing: string[], exitCodes: Record<string, number | null> = {}): ProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    home: "/Users/u",
    calls,
    exists: (p) => existing.includes(p),
    run: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      return exitCodes[file] ?? 1;
    },
  };
}

describe("probeRuntimes", () => {
  it("reports nothing installed when no absolute path exists", async () => {
    const d = deps([]);
    const res = await probeRuntimes(d);
    expect(res.ready).toBe(false);
    expect(res.runtimes.every((r) => !r.installed)).toBe(true);
    expect(d.calls).toEqual([]);
  });

  it("probes absolute paths only, never a bare command", async () => {
    const d = deps(["/opt/homebrew/bin/podman"], { "/opt/homebrew/bin/podman": 1 });
    await probeRuntimes(d);
    expect(d.calls.every((c) => c.startsWith("/"))).toBe(true);
  });

  it("installed but not running is not ready", async () => {
    const res = await probeRuntimes(deps(["/opt/homebrew/bin/podman"], { "/opt/homebrew/bin/podman": 125 }));
    const podman = res.runtimes.find((r) => r.kind === "podman")!;
    expect(podman).toMatchObject({ installed: true, running: false });
    expect(res.ready).toBe(false);
  });

  it("flips to ready on re-check once the runtime answers", async () => {
    const existing = ["/opt/homebrew/bin/podman"];
    const before = await probeRuntimes(deps(existing, { "/opt/homebrew/bin/podman": 125 }));
    const after = await probeRuntimes(deps(existing, { "/opt/homebrew/bin/podman": 0 }));
    expect(before.ready).toBe(false);
    expect(after.ready).toBe(true);
  });

  it("finds the vendored podman under the home dir", async () => {
    const p = "/Users/u/podman-dist/podman/bin/podman";
    const res = await probeRuntimes(deps([p], { [p]: 0 }));
    expect(res.runtimes.find((r) => r.kind === "podman")).toMatchObject({ installed: true, running: true, path: p });
  });

  it("Docker Desktop needs its .app bundle, a lone docker CLI is not enough", async () => {
    const lone = await probeRuntimes(deps(["/usr/local/bin/docker"], { "/usr/local/bin/docker": 0 }));
    expect(lone.runtimes.find((r) => r.kind === "docker-desktop")!.installed).toBe(false);
    const cli = "/Applications/Docker.app/Contents/Resources/bin/docker";
    const full = await probeRuntimes(deps(["/Applications/Docker.app", cli], { [cli]: 0 }));
    expect(full.runtimes.find((r) => r.kind === "docker-desktop")).toMatchObject({ installed: true, running: true });
  });

  it("colima uses `status`, and a spawn failure (null) is not running", async () => {
    const c = "/opt/homebrew/bin/colima";
    const d = deps([c], { [c]: null });
    const res = await probeRuntimes(d);
    expect(d.calls).toEqual([`${c} status`]);
    expect(res.runtimes.find((r) => r.kind === "colima")).toMatchObject({ installed: true, running: false });
  });

  it("candidate lists contain no relative entries", () => {
    for (const k of ["podman", "docker-desktop", "colima"] as const) {
      expect(candidatePaths(k, "/Users/u").every((p) => p.startsWith("/"))).toBe(true);
    }
  });
});
