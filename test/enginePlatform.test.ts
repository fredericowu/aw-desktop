import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess, ExecFileException } from "node:child_process";
import { darwinPlatform, platformFor, windowsPlatform } from "../src/main/enginePlatform";
import { GVPROXY_WINDOWS_SHA256, PODMAN_VERSION, PODMAN_WINDOWS_ZIP_SHA256 } from "../src/main/enginePin";
import { machineInitArgs, makeExecRunner, podmanEnv, workspacePaths, containersConf, type RuntimeConfig } from "../src/main/localRuntime";
import { podmanBinPath, runtimeConfig } from "../src/main/localWorkspaces";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/aw-test-userdata" } }));

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const host = { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", SECRET_TOKEN: "x" };

describe("platformFor", () => {
  it("selects by process.platform; anything but win32 keeps the mac behaviour", () => {
    expect(platformFor("win32")).toBe(windowsPlatform);
    expect(platformFor("darwin")).toBe(darwinPlatform);
    expect(platformFor("linux")).toBe(darwinPlatform);
  });
});

describe("darwin platform is the pre-seam behaviour", () => {
  const cfg: RuntimeConfig = runtimeConfig("/ud", "/Users/x", "/E", darwinPlatform);
  it("runtimeConfig is byte-identical to before", () => {
    expect(cfg.podmanPath).toBe("/E/bin/podman");
    expect(cfg.path).toBe("/E/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(cfg.homesRoot).toBe("/Users/x/.awd");
  });
  it("env has exactly the five variables, tmp under /tmp", () => {
    expect(workspacePaths(cfg, "l1").tmp).toBe("/tmp/aw-l1");
    expect(podmanEnv({ ...cfg, arch: "arm64" }, "l1")).toEqual({
      HOME: "/Users/x/.awd/l1/home",
      TMPDIR: "/tmp/aw-l1",
      PATH: cfg.path,
      CONTAINERS_MACHINE_PROVIDER: "libkrun",
      CONTAINERS_HELPER_BINARY_DIR: "/E/bin",
    });
  });
  it("machine init keeps sizing and the virtiofs share", () => {
    const a = machineInitArgs({ ...cfg }, "l1");
    expect(a.slice(0, 3)).toEqual(["machine", "init", "aw-l1"]);
    expect(a).toContain("--cpus");
    expect(a).toContain("--volume");
    expect(a[a.length - 1]).toBe("--now=false");
  });
  it("no default timeout and no tree kill", () => {
    expect(darwinPlatform.defaultTimeoutMs).toBe(0);
    expect(darwinPlatform.treeKill).toBe(false);
  });
});

describe("windows platform", () => {
  const w = windowsPlatform;
  it("names executables with .exe once", () => {
    expect(w.exeName("podman")).toBe("podman.exe");
    expect(w.exeName("podman.exe")).toBe("podman.exe");
    expect(podmanBinPath("C:/E", w)).toMatch(/podman\.exe$/);
  });
  it("PATH is semicolon separated and carries System32 from the host's SystemRoot", () => {
    const p = w.path("C:\\E\\bin", host);
    expect(p.split(";")[0]).toBe("C:\\E\\bin");
    expect(p).toContain("C:\\Windows\\System32");
    expect(p).not.toContain(":/usr/bin");
  });
  it("env uses the wsl provider, redirects profile and tmp, copies only system vars and nothing else", () => {
    const e = w.env({ home: "C:\\h\\l1\\home", tmp: "C:\\h\\t\\aw-l1", path: "P", provider: "wsl", helperDir: "C:\\E\\bin" }, host);
    expect(e.CONTAINERS_MACHINE_PROVIDER).toBe("wsl");
    expect(e.USERPROFILE).toBe("C:\\h\\l1\\home");
    expect(e.TEMP).toBe("C:\\h\\t\\aw-l1");
    expect(e.TMP).toBe(e.TEMP);
    expect(e.SystemRoot).toBe("C:\\Windows");
    expect(e.ComSpec).toBeDefined();
    expect(e).not.toHaveProperty("SECRET_TOKEN");
    expect(e).not.toHaveProperty("TMPDIR");
  });
  it("tmp root is not /tmp", () => {
    expect(w.tmpRoot("C:\\Users\\x\\.awd")).toBe("C:\\Users\\x\\.awd\\t");
  });
  it("machine init passes no sizing or share flags (W0 d)", () => {
    expect(w.machineInitFlags("D", { cpus: 2 })).toEqual([]);
    const cfg = { ...runtimeConfig("", "C:\\Users\\x", "C:\\E", w), platform: w };
    expect(machineInitArgs(cfg, "l1")).toEqual(["machine", "init", "aw-l1", "--now=false"]);
    expect(containersConf(cfg)).toContain('provider = "wsl"');
  });
  it("engine calls get a default timeout and a tree kill", () => {
    expect(w.defaultTimeoutMs).toBeGreaterThan(0);
    expect(w.treeKill).toBe(true);
  });
});

describe("makeExecRunner", () => {
  /** An exec stub that never completes by itself and records kills. */
  function hung() {
    const calls: { timeout: number | undefined }[] = [];
    let cb: ((e: ExecFileException | null, o: string, s: string) => void) | undefined;
    const killed: string[] = [];
    const child = { pid: 4242, kill: () => { killed.push("kill"); cb?.(Object.assign(new Error("killed"), { killed: true }) as ExecFileException, "", ""); return true; } } as unknown as ChildProcess;
    const exec = ((_c: string, _a: string[], o: { timeout?: number }, done: typeof cb) => { calls.push({ timeout: o.timeout }); cb = done; return child; }) as never;
    return { calls, killed, exec };
  }
  it("windows: a call with no timeout is still bounded, and the tree is killed on expiry", async () => {
    const h = hung();
    const tree: number[] = [];
    const plat = { ...windowsPlatform, defaultTimeoutMs: 20 };
    const r = await makeExecRunner(plat, h.exec, (pid) => tree.push(pid))("wsl", ["-l"], { env: {} });
    expect(h.calls[0]!.timeout).toBe(0); // node's own timer is off; ours owns the kill
    expect(tree).toEqual([4242]);
    expect(h.killed).toEqual(["kill"]);
    expect(r.code).toBe(1);
  });
  it("windows: an explicit timeout wins over the default", async () => {
    const h = hung();
    const tree: number[] = [];
    const t0 = Date.now();
    await makeExecRunner({ ...windowsPlatform, defaultTimeoutMs: 60_000 }, h.exec, (p) => tree.push(p))("x", [], { env: {}, timeoutMs: 15 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(tree).toEqual([4242]);
  });
  it("darwin: unchanged, node's own timeout, no tree kill", async () => {
    const calls: (number | undefined)[] = [];
    const exec = ((_c: string, _a: string[], o: { timeout?: number }, done: (e: null, o: string, s: string) => void) => {
      calls.push(o.timeout);
      done(null, "ok", "");
      return { pid: 1, kill: () => true } as unknown as ChildProcess;
    }) as never;
    const run = makeExecRunner(darwinPlatform, exec, () => { throw new Error("must not tree-kill"); });
    expect((await run("p", [], { env: {} })).stdout).toBe("ok");
    await run("p", [], { env: {}, timeoutMs: 5000 });
    expect(calls).toEqual([0, 5000]);
  });
});

describe("windows engine packaging", () => {
  const ref = read("scripts/engine-ref");
  it("scripts/engine-ref carries the pins the app knows", () => {
    expect(ref).toContain(`VERSION=${PODMAN_VERSION}\n`);
    expect(ref).toContain(`WINDOWS_AMD64_SHA256=${PODMAN_WINDOWS_ZIP_SHA256["x64"]}\n`);
    expect(ref).toContain(`GVPROXY_WINDOWS_SHA256=${GVPROXY_WINDOWS_SHA256}\n`);
  });
  it("the fetch script verifies before unpacking and swaps in the pinned gvproxy", () => {
    const ps = read("scripts/fetch-engine.ps1");
    expect(ps.indexOf("Check $zip")).toBeLessThan(ps.indexOf("Expand-Archive"));
    expect(ps).toContain("gvproxy-windows.exe");
    for (const b of ["podman.exe", "win-sshproxy.exe", "gvproxy.exe"]) expect(ps).toContain(b);
  });
  it("electron-builder bundles the engine on win, and the release job fetches it before packaging", () => {
    expect(read("electron-builder.yml")).toMatch(/win:[\s\S]*extraResources:[\s\S]*resources\/engine[\s\S]*to: engine/);
    const wf = read(".github/workflows/release.yml");
    const win = wf.slice(wf.indexOf("release-windows:"));
    expect(win.indexOf("fetch-engine.ps1")).toBeGreaterThan(-1);
    expect(win.indexOf("fetch-engine.ps1")).toBeLessThan(win.indexOf("electron-builder --win"));
  });
});
