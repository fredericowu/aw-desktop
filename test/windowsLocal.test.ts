import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/aw-test-userdata" } }));
import {
  LocalRuntime,
  PodmanCommandError,
  PortConflictError,
  UpgradeFailedError,
  bridgeName,
  machineName,
  pickSubnet,
  podmanEnv,
  postgresRunArgs,
  redisRunArgs,
  workspacePaths,
  workspaceRunArgs,
  type FsOps,
  type RunResult,
  type RuntimeConfig,
} from "../src/main/localRuntime";
import { windowsPlatform, darwinPlatform } from "../src/main/enginePlatform";
import { LocalRegistry, probeLoopbackPortBothFamilies, type RegistryStore } from "../src/main/localRegistry";
import type { LocalWorkspace } from "../src/main/localRegistry";
import { runPreflight, MIN_TOTAL_MEMORY_BYTES_WINDOWS, type PreflightProbe } from "../src/main/preflightCore";
import { classifyError } from "../src/main/errorClassifier";
import { failureCopy, FAILURE_COPY } from "../src/shared/errorCopy";
import { extractCode, findProtocolUrl } from "../src/main/oauthCore";
import { planWslConfig, ensureWslConfig, WSLCONFIG_MARKER } from "../src/main/wslConfig";
import { toWorkspaceInfo } from "../src/main/localWorkspaces";
import { wslState } from "../src/main/preflight";

const GIB = 1024 ** 3;
const win: RuntimeConfig = {
  podmanPath: "C:\\app\\resources\\engine\\bin\\podman.exe",
  homesRoot: "C:\\Users\\u\\.awd",
  dataRoot: "C:\\Users\\u\\aw-workspaces",
  path: "C:\\app\\resources\\engine\\bin;C:\\Windows\\System32",
  arch: "x64",
  platform: windowsPlatform,
};
const mkWs = (id: string, apiPort = 9032): LocalWorkspace => ({ id, name: id, sub: "s", uiPort: 9031, apiPort, createdAt: "t", cloud: "none" });
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("windows data layout: in-distro, never /mnt/c", () => {
  const p = workspacePaths(win, "localaaa");
  it("puts the four bind-mount sources inside the distro as POSIX paths", () => {
    expect(p.workspace).toBe("/home/user/aw/localaaa/workspace");
    expect(p.homeData).toBe("/home/user/aw/localaaa/home");
    expect(p.postgres).toBe("/home/user/aw/localaaa/postgres");
    expect(p.redis).toBe("/home/user/aw/localaaa/redis");
    for (const d of [p.workspace, p.homeData, p.postgres, p.redis]) expect(d).not.toMatch(/\/mnt\/|[A-Za-z]:\\/);
  });
  it("keeps the postgres password on the host side", () => {
    expect(p.passwordFile.startsWith("C:\\Users\\u\\aw-workspaces")).toBe(true); // host path, not /home/user/aw
    expect(p.passwordFile).toMatch(/localaaa.postgres-password$/);
  });
  it("the mac layout is unchanged", () => {
    const m = workspacePaths({ ...win, platform: darwinPlatform, dataRoot: "/Users/u/aw-workspaces", homesRoot: "/Users/u/.awd" }, "localaaa");
    expect(m.workspace).toBe("/Users/u/aw-workspaces/localaaa/workspace");
  });
});

describe("container flags", () => {
  it("every windows container carries --pids-limit 0 (W0 Q2: crun pids cgroup)", () => {
    const f = windowsPlatform.containerFlags();
    expect(postgresRunArgs("localaaa", "pw", "/d", f).join(" ")).toContain("--pids-limit 0");
    expect(redisRunArgs("localaaa", "/d", f).join(" ")).toContain("--pids-limit 0");
    const w = workspaceRunArgs({ ws: mkWs("localaaa"), paths: { workspace: "/w", homeData: "/h" }, password: "p", socketPath: "/s", image: "img", workers: 2, extraFlags: f });
    expect(w.join(" ")).toContain("--pids-limit 0");
  });
  it("publishes explicitly on 127.0.0.1 (W0 Q2: a plain -p misses 127.0.0.1)", () => {
    const w = workspaceRunArgs({ ws: mkWs("localaaa", 9055), paths: { workspace: "/w", homeData: "/h" }, password: "p", socketPath: "/s", image: "img", workers: 2 });
    expect(w).toContain("127.0.0.1:9055:9030");
  });
  it("mac builders are unchanged without flags", () => {
    expect(postgresRunArgs("localaaa", "pw", "/d").slice(0, 3)).toEqual(["run", "-d", "--name"]);
  });
});

describe("shared network namespace", () => {
  it("picks a subnet no distro in the namespace holds", () => {
    const routes = "default via 172.21.128.1 dev eth0\n10.89.0.0/24 dev podman1 proto kernel scope link src 10.89.0.1\n172.21.128.0/20 dev eth0";
    const s = pickSubnet(routes, "localaaa");
    expect(s).toMatch(/^10\.89\.\d+\.0\/24$/);
    expect(s).not.toBe("10.89.0.0/24");
    expect(Number(s.split(".")[2])).toBeGreaterThanOrEqual(16);
  });
  it("skips every subnet the route table (other distros) and our registry already use", () => {
    const first = pickSubnet("", "x");
    const next = pickSubnet(`10.89.${first.split(".")[2]}.0/24 dev br-other`, "x");
    expect(next).not.toBe(first);
    expect(pickSubnet("", "x", new Set([first]))).not.toBe(first);
  });
  it("treats a route broader than /24 as covering every /24 inside it", () => {
    const s = pickSubnet("10.89.128.0/17 dev eth0", "localaaa");
    expect(Number(s.split(".")[2])).toBeLessThan(128);
    expect(() => pickSubnet("10.89.0.0/16 dev eth0\ndefault via 1.1.1.1 dev eth0", "x")).toThrow(/no free/);
    expect(pickSubnet("default via 1.1.1.1 dev eth0", "x")).toMatch(/^10\.89\./); // default route is not a taken subnet
  });
  it("throws when the whole range is taken", () => {
    const all = Array.from({ length: 235 }, (_, i) => `10.89.${16 + i}.0/24 dev b${i}`).join("\n");
    expect(() => pickSubnet(all, "x")).toThrow(/no free/);
  });
  it("bridge names fit the 15 byte interface limit and are per workspace", () => {
    expect(bridgeName("localaaa")).toBe("awlocalaaa");
    expect(bridgeName("a".repeat(40)).length).toBe(15);
    expect(bridgeName("localaaa")).not.toBe(bridgeName("localbbb"));
  });
});

function winHarness(handler: (args: string[]) => RunResult | undefined) {
  const calls: string[][] = [];
  const dirs: string[] = [];
  const fs: FsOps = { mkdirp: (p) => void dirs.push(p), writeFile() {}, readFile: () => null, isEmptyDir: () => true, rename() {}, listDir: () => [], exists: () => false, rmrf() {} };
  let t = 0;
  const rt = new LocalRuntime(win, {
    fs, sleep: async () => void (t += 1000), now: () => t, newSecret: () => "pw", httpStatus: async () => 200,
    run: async (_c, args) => {
      calls.push(args);
      const c = handler(args);
      if (c) return c;
      const j = args.join(" ");
      if (j.includes("{{.Running}}")) return ok("aw-localaaa true\n");
      if (j.includes("machine list")) return ok("aw-localaaa*\n");
      if (j.includes("ip -4 route")) return ok("10.89.0.0/24 dev podman1\n");
      if (j.includes("ls -A")) return ok("empty\n");
      if (j.includes("machine ssh")) return ok("/run/user/1000/podman/podman.sock");
      if (j.includes(" exists ")) return { code: 1, stdout: "", stderr: "" };
      if (j.includes("pg_database")) return ok("");
      if (j.includes("PortBindings")) return ok("{}");
      return ok();
    },
  });
  return { rt, calls, dirs };
}

describe("windows start", () => {
  it("creates the data dirs inside the distro through machine ssh, not on the host", async () => {
    const h = winHarness(() => undefined);
    await h.rt.start(mkWs("localaaa"));
    const mk = h.calls.find((a) => a.join(" ").includes("mkdir -p"));
    expect(mk?.slice(0, 3)).toEqual(["machine", "ssh", machineName("localaaa")]);
    expect(mk?.join(" ")).toContain("/home/user/aw/localaaa/postgres");
    expect(h.dirs.some((d) => d.includes("/home/user/aw"))).toBe(false);
  });
  it("seeds with a one-shot container copying into the in-distro dir, never `podman cp`", async () => {
    const h = winHarness(() => undefined);
    await h.rt.start(mkWs("localaaa"));
    expect(h.calls.some((a) => a.includes("cp"))).toBe(false);
    const seed = h.calls.find((a) => a.includes("--rm") && a.includes("--entrypoint"));
    expect(seed).toBeDefined();
    expect(seed).toContain("/home/user/aw/localaaa:/seed"); // the PARENT: copy is staged, then published by rename
    expect(seed!.join(" ")).toMatch(/cp -a .*workspace\.seeding.*mv \/seed\/workspace\.seeding \/seed\/workspace/);
    expect(seed).toContain("--pids-limit");
    // rootless machine: the seed must run as root and chown to the image user, or the core cannot write its dirs
    expect(seed![seed!.indexOf("--user") + 1]).toBe("0");
    // ownership is finished BEFORE the publishing rename, so a failed chown leaves no tree the next start takes for seeded
    expect(seed!.join(" ")).toMatch(/chown -R "\$own" \/seed\/workspace\.seeding \/seed\/home;.*mv \/seed\/workspace\.seeding \/seed\/workspace/);
  });
  it("does not re-seed a workspace dir that already has content", async () => {
    const h = winHarness((a) => (a.join(" ").includes("ls -A") ? ok("full\n") : undefined));
    await h.rt.start(mkWs("localaaa"));
    expect(h.calls.some((a) => a.includes("--entrypoint"))).toBe(false);
  });
  it("creates the network with an explicit subnet and its own bridge name", async () => {
    const h = winHarness(() => undefined);
    await h.rt.start(mkWs("localaaa"));
    const net = h.calls.find((a) => a.includes("network") && a.includes("create"))!;
    expect(net).toContain("--subnet");
    expect(net[net.indexOf("--subnet") + 1]).toMatch(/^10\.89\.\d+\.0\/24$/);
    expect(net).toContain("--interface-name");
    expect(net[net.indexOf("--interface-name") + 1]).toBe(bridgeName("localaaa"));
  });
  it("turns pasta's 'address already in use' into a PortConflictError and clears the half-made container", async () => {
    const h = winHarness((a) =>
      a.includes("run") && a.includes("--init")
        ? { code: 126, stdout: "", stderr: "Error: pasta failed with exit code 1:\nListen failed for HOST TCP port */9032: Address already in use" }
        : undefined,
    );
    const err = await h.rt.start(mkWs("localaaa", 9032)).catch((e) => e);
    expect(err).toBeInstanceOf(PortConflictError);
    expect(err.port).toBe(9032);
    expect(h.calls.some((a) => a.includes("rm") && a.includes("aw-localaaa-workspace"))).toBe(true);
  });
  const WSL_FLAKE = { code: 125, stdout: "", stderr: "Error: command C:\\Windows\\System32\\wsl.exe [-u root -d podman-aw-localaaa sh] failed: exit status 0xffffffff ()" };
  const isSockProbe = (a: string[]) => a[0] === "machine" && a[1] === "ssh" && a.join(" ").includes("podman.sock");
  it("retries the socket probe when wsl.exe fails transiently (0xffffffff) instead of failing Create", async () => {
    let n = 0;
    const h = winHarness((a) => (isSockProbe(a) && n++ < 2 ? WSL_FLAKE : undefined));
    await h.rt.start(mkWs("localaaa"));
    expect(h.calls.filter(isSockProbe)).toHaveLength(3); // 2 transient failures, then the real answer
  });
  it("gives up after a bounded number of transient failures and reports the real error", async () => {
    const h = winHarness((a) => (isSockProbe(a) ? WSL_FLAKE : undefined));
    const err = await h.rt.start(mkWs("localaaa")).catch((e) => e);
    expect(err).toBeInstanceOf(PodmanCommandError);
    expect(h.calls.filter(isSockProbe)).toHaveLength(4);
  });
  it("does not retry a machine ssh failure that is not the transient wsl one", async () => {
    const h = winHarness((a) => (isSockProbe(a) ? { code: 125, stdout: "", stderr: "Error: no such machine" } : undefined));
    const err = await h.rt.start(mkWs("localaaa")).catch((e) => e);
    expect(err).toBeInstanceOf(PodmanCommandError);
    expect(h.calls.filter(isSockProbe)).toHaveLength(1);
  });
  it("another failure of the same step is NOT a port conflict", async () => {
    const h = winHarness((a) => (a.includes("run") && a.includes("--init") ? { code: 125, stdout: "", stderr: "image not known" } : undefined));
    const err = await h.rt.start(mkWs("localaaa")).catch((e) => e);
    expect(err).toBeInstanceOf(PodmanCommandError);
  });
  it("the in-place upgrade is refused on windows and nothing runs", async () => {
    const h = winHarness(() => undefined);
    const err = await h.rt.upgrade(mkWs("localaaa")).catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeFailedError);
    expect(h.calls).toHaveLength(0);
  });
});

describe("distro naming and isolation", () => {
  it("never produces a name that can equal a distro this app did not create", () => {
    const env = podmanEnv(win, "localaaa");
    expect(env["CONTAINERS_MACHINE_PROVIDER"]).toBe("wsl");
    // podman names the WSL distro "podman-<machine>": always prefixed, so aw-ubuntu / docker-desktop* cannot collide
    for (const id of ["ubuntu", "localaaa", "dockerdesktop"]) {
      const distro = `podman-${machineName(id)}`;
      expect(distro).not.toBe("aw-ubuntu");
      expect(distro.startsWith("podman-aw-")).toBe(true);
    }
  });
  it("destroy removes only this workspace's machine by name", async () => {
    let removed = false;
    const h = winHarness((a) => {
      const j = a.join(" ");
      if (j.startsWith("machine rm")) { removed = true; return ok(); }
      if (removed && j.includes("machine list")) return ok("");
      return undefined;
    });
    await h.rt.destroy("localaaa");
    const rm = h.calls.find((a) => a.includes("machine") && a.includes("rm"));
    expect(rm).toEqual(["machine", "rm", "--force", "aw-localaaa"]);
    expect(h.calls.every((a) => !a.includes("aw-ubuntu"))).toBe(true);
  });
});

describe("port allocation across distros", () => {
  const store = (): RegistryStore => {
    let d: string | null = null;
    return { read: () => d, write: (x) => void (d = x) };
  };
  it("reconcile avoids a port the engine reported busy even though the probe says free", async () => {
    const reg = new LocalRegistry({ store: store(), isPortFree: async () => true, newId: () => "localaaa" });
    const ws = await reg.create("s", "x");
    const r = await reg.reconcilePorts(ws.id, () => false, new Set([ws.apiPort]));
    expect(r.apiChanged).toBe(true);
    expect(r.workspace.apiPort).not.toBe(ws.apiPort);
    expect(r.workspace.apiPort).not.toBe(9030);
  });
  it("the dual-family probe reports a held loopback port as busy", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    expect(await probeLoopbackPortBothFamilies(port)).toBe(false);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await probeLoopbackPortBothFamilies(port)).toBe(true);
  });
});

describe("windows preflight", () => {
  const good = (over: Partial<PreflightProbe> = {}): PreflightProbe => ({
    platform: "win32", arch: "x64", totalMemBytes: 7.9 * GIB, freeDiskBytes: 80 * GIB,
    homesRoot: "C:\\Users\\u\\.awd", engineRuns: true, hypervisorSupported: async () => true, wslState: async () => "ready", ...over,
  });
  it("admits the 7.9 GiB Surface (PO floor 7.5 GiB) and blocks below it", async () => {
    expect(await runPreflight(good())).toEqual({ ok: true });
    expect((await runPreflight(good({ totalMemBytes: MIN_TOTAL_MEMORY_BYTES_WINDOWS - 1 }))).code).toBe("low_memory");
    expect(MIN_TOTAL_MEMORY_BYTES_WINDOWS).toBe(7.5 * GIB);
  });
  it("is no longer the Mac refusal, and skips the macOS socket-path check", async () => {
    expect((await runPreflight(good({ homesRoot: "C:\\Users\\" + "a".repeat(80) + "\\.awd" }))).ok).toBe(true);
  });
  it("missing WSL: guided copy names WSL, administrator access and a restart, plus steps", async () => {
    const r = await runPreflight(good({ wslState: async () => "missing" }));
    expect(r.code).toBe("wsl_missing");
    expect(r.message).toMatch(/Windows Subsystem for Linux \(WSL\)/);
    expect(r.message).toMatch(/administrator/);
    expect(r.message).toMatch(/restart/);
    expect(r.steps?.join(" ")).toMatch(/wsl --install/);
    expect(r.steps?.join(" ")).toMatch(/Restart your PC/);
  });
  it("unresponsive WSL: tells the user to restart, and a throwing probe counts as unresponsive", async () => {
    const r = await runPreflight(good({ wslState: async () => "unresponsive" }));
    expect(r.code).toBe("wsl_unresponsive");
    expect(r.message).toMatch(/WSL/);
    expect(r.message).toMatch(/Restart your PC/);
    expect((await runPreflight(good({ wslState: async () => { throw new Error("x"); } }))).code).toBe("wsl_unresponsive");
  });
  it("arm64 Windows is refused (only the amd64 engine is bundled) without Mac wording", async () => {
    const r = await runPreflight(good({ arch: "arm64" }));
    expect(r.code).toBe("virtualization_unavailable");
    expect(r.message).toBe("This PC can't run local workspaces.");
  });
  it("no 'Mac' word reaches any Windows preflight message", async () => {
    for (const over of [{ arch: "arm64" }, { totalMemBytes: 0 }, { freeDiskBytes: 0 }, { engineRuns: false }, { wslState: async () => "missing" as const }, { wslState: async () => "unresponsive" as const }]) {
      const r = await runPreflight(good(over as Partial<PreflightProbe>));
      expect(r.message ?? "").not.toMatch(/\bMac\b/);
    }
  });
  it("a missing OpenSSH client is reported before WSL is probed", async () => {
    let called = false;
    const r = await runPreflight(good({ sshAvailable: () => false, wslState: async () => { called = true; return "ready"; } }));
    expect(r.code).toBe("ssh_missing");
    expect(called).toBe(false);
    expect((await runPreflight(good({ sshAvailable: () => true }))).ok).toBe(true);
  });
  it("the engine PATH includes the system OpenSSH dir", () => {
    expect(windowsPlatform.path("C:\\e", { SystemRoot: "C:\\Windows" })).toContain("C:\\Windows\\System32\\OpenSSH");
  });
  it("probes WSL last: a cheap failure never spawns wsl.exe", async () => {
    let called = false;
    await runPreflight(good({ totalMemBytes: 0, wslState: async () => { called = true; return "ready"; } }));
    expect(called).toBe(false);
  });
  it("macOS preflight is unchanged", async () => {
    const r = await runPreflight({ ...good(), platform: "darwin", arch: "arm64", totalMemBytes: 16 * GIB, homesRoot: "/Users/u/.awd" });
    expect(r).toEqual({ ok: true });
    expect((await runPreflight({ ...good(), platform: "linux" })).message).toBe("This Mac can't run local workspaces.");
  });
});

describe("wsl probe", () => {
  const run = (r: RunResult) => async () => r;
  it("exit 0 is ready; a deadline hit is unresponsive; any other failure is missing", async () => {
    expect(await wslState(run(ok()), { SystemRoot: "C:\\Windows" })).toBe("ready");
    expect(await wslState(run({ code: 1, stdout: "", stderr: "timed out after 15s" }), {})).toBe("unresponsive");
    expect(await wslState(run({ code: 1, stdout: "", stderr: "" }), {})).toBe("missing");
  });
  it("runs wsl.exe from System32 with a 15s deadline", async () => {
    let seen: { cmd: string; t?: number } | null = null;
    await wslState(async (cmd, _a, o) => { seen = { cmd, t: o.timeoutMs }; return ok(); }, { SystemRoot: "C:\\Windows" });
    expect(seen).toEqual({ cmd: "C:\\Windows\\System32\\wsl.exe", t: 15000 });
  });
});

describe("failure copy on windows", () => {
  it("a runner deadline classifies as 'not responding', in PC wording", () => {
    const c = classifyError(new Error("podman machine start failed (exit 1): timed out after 300s"), "pc");
    expect(c.code).toBe("engine_unresponsive");
    expect(c.message).not.toMatch(/\bMac\b/);
  });
  it("wsl failures classify to the guided codes", () => {
    expect(classifyError(new Error("WSL is not installed"), "pc").code).toBe("wsl_missing");
    expect(classifyError(new Error("Error code: Wsl/Service/CreateInstance/HCS_E_HYPERV_NOT_INSTALLED"), "pc").code).toBe("virtualization_unavailable");
  });
  it("every Mac sentence has a PC form", () => {
    for (const c of Object.keys(FAILURE_COPY) as (keyof typeof FAILURE_COPY)[]) {
      expect(failureCopy(c, undefined, "pc")).not.toMatch(/\bMac\b/);
    }
    expect(failureCopy("virtualization_unavailable")).toBe("This Mac can't run local workspaces.");
  });
  it("WSL is named only in the prerequisite codes", () => {
    for (const [c, t] of Object.entries(FAILURE_COPY)) {
      if (c === "wsl_missing" || c === "wsl_unresponsive") expect(t).toMatch(/WSL/);
      else expect(t).not.toMatch(/WSL|Subsystem/);
    }
  });
});

describe("upgrade is hidden on windows", () => {
  const old = { ...mkWs("localaaa") }; // no image pin = legacy = upgrade available on a Mac
  it("mac shows upgrade_available, windows does not", () => {
    expect(toWorkspaceInfo(old, true, null, darwinPlatform).upgrade_available).toBe(true);
    expect(toWorkspaceInfo(old, true, null, windowsPlatform).upgrade_available).toBeUndefined();
  });
});

describe("google sign-in callback on windows", () => {
  it("finds the awdesktop:// url in a second instance's argv, quoted or not", () => {
    const url = "awdesktop://auth?code=abc123";
    expect(findProtocolUrl(["C:\\app\\AW Desktop.exe", "--flag", url], "awdesktop")).toBe(url);
    expect(findProtocolUrl(["x.exe", `"${url}"`], "awdesktop")).toBe(url);
    expect(findProtocolUrl(["x.exe", "AWDESKTOP://auth?code=z"], "awdesktop")).toBe("AWDESKTOP://auth?code=z");
    expect(findProtocolUrl(["x.exe", "https://evil/awdesktop://"], "awdesktop")).toBeNull();
    expect(findProtocolUrl([], "awdesktop")).toBeNull();
  });
  it("extracts the one-time code", () => {
    expect(extractCode("awdesktop://auth?code=abc123")).toBe("abc123");
    expect(extractCode("awdesktop://auth")).toBeNull();
    expect(extractCode("not a url")).toBeNull();
  });
});

describe(".wslconfig strategy", () => {
  it("never edits an existing file, even an empty one", () => {
    expect(planWslConfig("")).toEqual({ action: "leave", reason: "exists" });
    expect(planWslConfig("[wsl2]\nmemory=2GB\n").action).toBe("leave");
  });
  it("writes a file that does not shrink the VM when none exists", () => {
    const p = planWslConfig(null);
    expect(p.action).toBe("write");
    expect(p.contents).toContain(WSLCONFIG_MARKER);
    expect(p.contents).toContain("autoMemoryReclaim=gradual");
    expect(p.contents).not.toMatch(/memory\s*=/);
  });
  it("writes to the real profile once, never throws, and never mentions shutting WSL down in code", () => {
    const writes: Array<[string, string]> = [];
    ensureWslConfig("C:\\Users\\u", { read: () => null, write: (p, d) => void writes.push([p, d]) });
    expect(writes[0]![0]).toBe("C:\\Users\\u\\.wslconfig");
    expect(() => ensureWslConfig("C:\\Users\\u", { read: () => null, write: () => { throw new Error("EACCES"); } })).not.toThrow();
    ensureWslConfig("C:\\Users\\u", { read: () => "[wsl2]\n", write: (p, d) => void writes.push([p, d]) });
    expect(writes).toHaveLength(1);
  });
});
