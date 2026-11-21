import { afterEach, describe, expect, it, vi } from "vitest";
import { openIfCurrent, scopedExclusive, SessionScope, SetupSlot, bootstrapArgs, childEnv, fetchBytes, exclusive, lockFileInFlight, readHostStatus, runBootstrapFlow, type FlowDeps, type HostOps } from "../src/main/localBootstrap";
import type { BootstrapProgress } from "../src/shared/types";

function ops(over: Partial<HostOps> = {}): HostOps {
  return {
    findBinary: () => "/bin/arh",
    hasCredentials: () => false,
    runStatus: async () => "linked: no (no credentials found)",
    installBinary: vi.fn(async () => "/home/.local/bin/aw-remote-host"),
    runBootstrap: vi.fn(async (_b, _t, _cp, onLine) => {
      onLine("podman: installed and verified");
      return 0;
    }),
    installerInFlight: () => false,
    killBootstrap: vi.fn(async () => undefined),
    ...over,
  };
}

function deps(o: HostOps, over: Partial<FlowDeps> = {}) {
  const events: BootstrapProgress[] = [];
  let t = 0;
  const d: FlowDeps = {
    ops: o,
    mintToken: vi.fn(async () => "awbs_secret_token"),
    getStatus: vi.fn(async () => "running"),
    emit: (p) => events.push(p),
    sleep: async () => undefined,
    now: () => (t += 1000),
    pollIntervalMs: 1,
    pollTimeoutMs: 5000,
    ...over,
  };
  return { d, events };
}

describe("readHostStatus", () => {
  it("no binary + no credentials => clean", async () => {
    expect(await readHostStatus({ ...ops({ findBinary: () => null }) })).toEqual({ binary: false, linked: false });
  });
  it("no binary but credentials exist => linked/unknown (never guess clean)", async () => {
    const r = await readHostStatus({ ...ops({ findBinary: () => null, hasCredentials: () => true }) });
    expect(r).toMatchObject({ linked: true, unknown: true });
  });
  it("status failing to run => unknown", async () => {
    expect(await readHostStatus({ ...ops({ runStatus: async () => null }) })).toMatchObject({ linked: true, unknown: true });
  });
});

describe("runBootstrapFlow", () => {
  it("happy path: mints a token, passes it to the CLI, waits for running, completes", async () => {
    const o = ops();
    const { d, events } = deps(o);
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("done");
    expect(d.mintToken).toHaveBeenCalledWith("w");
    expect(o.runBootstrap).toHaveBeenCalledWith("/bin/arh", "awbs_secret_token", undefined, expect.any(Function));
    expect(JSON.stringify(events)).not.toContain("awbs_secret_token");
  });

  it("installs the pinned binary only when none exists", async () => {
    const o = ops({ findBinary: vi.fn().mockReturnValueOnce(null).mockReturnValue(null) });
    const { d } = deps(o);
    await runBootstrapFlow("w", d);
    expect(o.installBinary).toHaveBeenCalledTimes(1);
    expect(o.runBootstrap).toHaveBeenCalledWith("/home/.local/bin/aw-remote-host", "awbs_secret_token", undefined, expect.any(Function));
  });

  it("already-linked Mac: blocks BEFORE minting a token or running bootstrap", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: fredericowu" });
    const { d } = deps(o);
    const p = await runBootstrapFlow("new-one", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("already hosts a workspace");
    expect(d.mintToken).not.toHaveBeenCalled();
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("resume of the same linked workspace reuses the credential: no token minted", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w" });
    const { d } = deps(o, { getRowHostId: async () => "r" });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("done");
    expect(d.mintToken).not.toHaveBeenCalled();
    expect(o.runBootstrap).toHaveBeenCalledWith("/bin/arh", null, undefined, expect.any(Function));
  });

  it("CLI failure reports the failing step and the last log lines", async () => {
    const o = ops({
      runBootstrap: async (_b, _t, _cp, onLine) => {
        onLine("podman: FAILED");
        onLine("machine init: no space left");
        return 1;
      },
    });
    const { d } = deps(o);
    const p = await runBootstrapFlow("w", d);
    expect(p).toMatchObject({ phase: "failed", failedStep: "podman" });
    expect(p.error).toContain("code 1");
    expect(p.lines).toContain("machine init: no space left");
  });

  it("times out when the workspace never reaches running", async () => {
    const { d } = deps(ops(), { getStatus: async () => "provisioning", pollTimeoutMs: 3000 });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("last status: provisioning");
  });

  it("a checksum failure during install fails the flow at the first step and runs nothing", async () => {
    const o = ops({
      findBinary: () => null,
      installBinary: async () => {
        throw new Error("checksum mismatch for x");
      },
    });
    const { d } = deps(o);
    const p = await runBootstrapFlow("w", d);
    expect(p).toMatchObject({ phase: "failed", failedStep: "cli" });
    expect(o.runBootstrap).not.toHaveBeenCalled();
    expect(d.mintToken).not.toHaveBeenCalled();
  });

  it("a token-mint failure (e.g. 403) is a failed step, not a throw", async () => {
    const { d } = deps(ops(), { mintToken: async () => { throw new Error("forbidden"); } });
    const p = await runBootstrapFlow("w", d);
    expect(p).toMatchObject({ phase: "failed", failedStep: "token" });
  });
});

describe("review-fix regressions", () => {
  it("passes the desktop's control plane to the CLI (self-hosted apex)", async () => {
    const o = ops();
    const { d } = deps(o, { controlPlane: "https://api.self.example" });
    await runBootstrapFlow("w", d);
    expect(o.runBootstrap).toHaveBeenCalledWith("/bin/arh", "awbs_secret_token", "https://api.self.example", expect.any(Function));
  });

  it("a status request that never settles cannot wedge the poll loop", async () => {
    const { d } = deps(ops(), {
      getStatus: () => new Promise<string>(() => undefined),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pollIntervalMs: 5,
      pollTimeoutMs: 150,
    });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("did not reach running");
  });

  it("the status request is aborted when its budget runs out", async () => {
    let aborted = false;
    const { d } = deps(ops(), {
      getStatus: (_s, signal) =>
        new Promise<string>((_r, rej) => signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      pollIntervalMs: 5,
      pollTimeoutMs: 100,
    });
    await runBootstrapFlow("w", d);
    expect(aborted).toBe(true);
  });
});

describe("bootstrapArgs", () => {
  it("includes --control-plane when given, and --token only when minted", () => {
    expect(bootstrapArgs("awbs_x", "https://api.self.example")).toEqual([
      "bootstrap-workspace", "--with-workspace", "--yes", "--background",
      "--token", "awbs_x", "--control-plane", "https://api.self.example",
    ]);
    expect(bootstrapArgs(null)).toEqual(["bootstrap-workspace", "--with-workspace", "--yes", "--background"]);
  });
});

describe("childEnv (PATH parity with the LaunchAgent)", () => {
  it("is the vendored podman dir plus launchd's default, even when the app PATH has Homebrew", () => {
    const env = childEnv({ PATH: "/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:/usr/bin:/bin", HOME: "/Users/me" }, "/Users/me");
    expect(env.PATH).toBe("/Users/me/podman-dist/podman/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.PATH).not.toMatch(/homebrew|\/usr\/local|\/opt\/podman/);
  });
  it("is the same whether the app was launched from Finder (bare PATH) or a terminal, and keeps other vars", () => {
    const finder = childEnv({ HOME: "/Users/me" }, "/Users/me");
    const term = childEnv({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me" }, "/Users/me");
    expect(finder.PATH).toBe(term.PATH);
    expect(term.HOME).toBe("/Users/me");
  });
});

describe("review round 4 regressions", () => {
  it("a bootstrap child that never exits is killed and fails with a Retry-able error", async () => {
    const o = ops({ runBootstrap: () => new Promise<number | null>(() => undefined) });
    const { d } = deps(o, { bootstrapTimeoutMs: 50 });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("did not finish");
    expect(o.killBootstrap).toHaveBeenCalledTimes(1);
  });

  it("partial registration: linked host, no slug, row bound to the same host id => resumes without a token", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=rh_1)\nprovisioned: no" });
    const { d } = deps(o, { getRowHostId: async () => "rh_1" });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("done");
    expect(d.mintToken).not.toHaveBeenCalled();
    expect(o.runBootstrap).toHaveBeenCalledWith("/bin/arh", null, undefined, expect.any(Function));
  });

  it("partial registration with a DIFFERENT row host id (or lookup failure) still blocks", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=rh_1)" });
    for (const getRowHostId of [async () => "rh_other", async (): Promise<string | null> => { throw new Error("net"); }, async () => null]) {
      const { d } = deps(o, { getRowHostId });
      const p = await runBootstrapFlow("w", d);
      expect(p.phase).toBe("failed");
    }
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });
});

describe("round 5 regressions", () => {
  it("the child's whole process tree is stopped (awaited) before the flow fails, so Retry cannot overlap it", async () => {
    let treeGone = false;
    const o = ops({
      runBootstrap: () => new Promise<number | null>(() => undefined),
      killBootstrap: async () => {
        await new Promise((r) => setTimeout(r, 30));
        treeGone = true;
      },
    });
    const { d, events } = deps(o, { bootstrapTimeoutMs: 20 });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(treeGone).toBe(true);
    expect(events.filter((e) => e.phase === "failed").length).toBe(1);
  });

  it("a request that began before sign-out is not current after sign-out + sign-in, even when it resolves late", async () => {
    const slot = new SetupSlot();
    const scope = new SessionScope();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let currentAfterAwait: boolean | null = null;
    const pending = scopedExclusive(slot, scope, "busy", async (session) => {
      await gate; // e.g. createWorkspace response arriving late
      currentAfterAwait = session.isCurrent();
      return "done";
    });
    scope.end(); // A logs out
    scope.begin(); // B signs in and starts something
    release();
    await pending;
    expect(currentAfterAwait).toBe(false);
  });
});

describe("round 6 regressions", () => {
  it("same slug on a Mac linked to ANOTHER control plane (row host id differs) never launches the CLI", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=rh_A)\nworkspace: w" });
    const { d } = deps(o, { getRowHostId: async () => "rh_B" });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("session ended while the token mint is pending: the CLI is never launched", async () => {
    const ac = new AbortController();
    const o = ops();
    const { d } = deps(o, {
      signal: ac.signal,
      mintToken: async () => {
        ac.abort(); // sign-out while the request is in flight
        return "awbs_late";
      },
    });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toBe("cancelled");
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("session ended while the child runs: the child tree is killed (awaited) before the slot is freed", async () => {
    const ac = new AbortController();
    let gone = false;
    const o = ops({
      runBootstrap: () => new Promise<number | null>(() => undefined),
      killBootstrap: async () => {
        await new Promise((r) => setTimeout(r, 20));
        gone = true;
      },
    });
    const { d } = deps(o, { signal: ac.signal });
    const run = runBootstrapFlow("w", d);
    setTimeout(() => ac.abort(), 10);
    const p = await run;
    expect(p.error).toBe("cancelled");
    expect(gone).toBe(true);
  });
});

describe("round 7 regressions", () => {
  const linked = () => ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w" });
  const handoff = (at: number | null) => {
    const marks: number[] = [];
    return { marks, h: { lastLaunchedAt: () => at, markLaunched: (_s: string, t: number) => void marks.push(t), } };
  };

  const MIN = 60 * 1000;

  it("3 min after hand-off with an idle installer lock: Retry re-runs the bootstrap", async () => {
    const o = linked();
    const { h, marks } = handoff(1_000);
    let n = 0;
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: h, now: () => 1_000 + 3 * MIN, getStatus: async () => (n++ === 0 ? "provisioning" : "running") });
    const p = await runBootstrapFlow("w", d);
    expect(o.runBootstrap).toHaveBeenCalledTimes(1);
    expect(marks.length).toBe(1);
    expect(p.phase).toBeDefined();
  });

  it("3 min after hand-off with a LIVE installer lock: monitor only, no second installer", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w", installerInFlight: () => true });
    const { h } = handoff(1_000);
    let status = "provisioning";
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: h, now: () => 1_000 + 3 * MIN, getStatus: vi.fn(async () => { const s = status; status = "running"; return s; }) });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("done");
    expect(o.runBootstrap).not.toHaveBeenCalled();
    expect(o.installBinary).not.toHaveBeenCalled();
  });

  it("inside the settle window (no lock yet) a Retry only monitors", async () => {
    const o = linked();
    const { h } = handoff(1_000);
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: h, now: () => 2_000 });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("done");
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("error/stopped row on a Mac that is NOT provisioned is refused, no CLI launch", async () => {
    for (const st of ["error", "stopped"]) {
      const o = linked();
      const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(null).h, getStatus: async () => st });
      const p = await runBootstrapFlow("w", d);
      expect(p.phase).toBe("failed");
      expect(p.error).toContain(st);
      expect(o.runBootstrap).not.toHaveBeenCalled();
    }
  });

  it("error/stopped row on a Mac that reports provisioned: relaunch is allowed", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w\npodman: healthy\npostgres: healthy" });
    let n = 0;
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(null).h, getStatus: async () => (n++ === 0 ? "stopped" : "running") });
    const p = await runBootstrapFlow("w", d);
    expect(o.runBootstrap).toHaveBeenCalledTimes(1);
    expect(p.phase).toBe("done");
  });

  it("error/stopped row on a provisioned Mac with a LIVE installer lock never relaunches", async () => {
    for (const st of ["error", "stopped"]) {
      const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w\npodman: healthy", installerInFlight: () => true });
      const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(null).h, getStatus: async () => st });
      const p = await runBootstrapFlow("w", d);
      expect(p.phase).toBe("failed");
      expect(p.error).toContain("still running an install");
      expect(o.runBootstrap).not.toHaveBeenCalled();
    }
  });

  it("an unreadable resume row never relaunches", async () => {
    const o = linked();
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(null).h, getStatus: async () => { throw new Error("net"); } });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("after the settle window, 90s continuously without an installer fails with Retry", async () => {
    const o = linked();
    let t = 1_000 + 3 * MIN;
    const { h } = handoff(1_000);
    // monitor-only is forced by a live lock at entry, then the lock vanishes
    let calls = 0;
    o.installerInFlight = () => calls++ === 0;
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: h, now: () => t, sleep: async () => void (t += 30_000), pollTimeoutMs: 60 * MIN, getStatus: async () => "provisioning" });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("no longer running");
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("status API outage past the idle window does not fail the wait", async () => {
    const o = linked();
    let t = 1_000 + 3 * MIN;
    let calls = 0;
    o.installerInFlight = () => calls++ === 0;
    let n = 0;
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(1_000).h, now: () => t, sleep: async () => void (t += 30_000), pollTimeoutMs: 60 * MIN, getStatus: async () => { n++; if (n === 1) return "provisioning"; if (n <= 7) throw new Error("net"); return "running"; } });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("done");
  });

  it("a row turning error mid-wait fails immediately", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w", installerInFlight: () => true });
    let n = 0;
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(1_000).h, now: () => 1_000 + 3 * MIN, getStatus: async () => (n++ < 2 ? "provisioning" : "error") });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(p.error).toContain("error");
  });

  it("a timed-out wait fails without relaunching", async () => {
    const o = ops({ runStatus: async () => "linked: yes (remote_host_id=r)\nworkspace: w", installerInFlight: () => true });
    let t = 2_000;
    const { d } = deps(o, { getRowHostId: async () => "r", handoff: handoff(1_000).h, now: () => (t += 10_000_000), getStatus: async () => "provisioning" });
    const p = await runBootstrapFlow("w", d);
    expect(p.phase).toBe("failed");
    expect(o.runBootstrap).not.toHaveBeenCalled();
  });

  it("a first run records the hand-off only after the CLI exited 0", async () => {
    const { h, marks } = handoff(null);
    const failing = ops({ runBootstrap: async () => 1 });
    await runBootstrapFlow("w", deps(failing, { handoff: h }).d);
    expect(marks.length).toBe(0);
    await runBootstrapFlow("w", deps(ops(), { handoff: h }).d);
    expect(marks.length).toBe(1);
  });

  it("openIfCurrent: sign-out during the cookie write never opens the shell and undoes the cookie", async () => {
    let current = true;
    const log: string[] = [];
    const ok = await openIfCurrent(
      () => current,
      async () => {
        log.push("cookie");
        current = false; // teardown lands while the cookie is being written
      },
      () => log.push("open"),
      () => log.push("undo"),
    );
    expect(ok).toBe(false);
    expect(log).toEqual(["cookie", "undo"]);
  });

  it("openIfCurrent opens when the session survives", async () => {
    const log: string[] = [];
    expect(await openIfCurrent(() => true, async () => void log.push("c"), () => log.push("open"), () => log.push("undo"))).toBe(true);
    expect(log).toEqual(["c", "open"]);
  });
});

describe("SessionScope", () => {
  it("end() invalidates earlier jobs and aborts them; later jobs are current", () => {
    const s = new SessionScope();
    const a = s.begin();
    expect(a.isCurrent()).toBe(true);
    s.end();
    expect(a.isCurrent()).toBe(false);
    expect(a.signal.aborted).toBe(true);
    const b = s.begin();
    expect(b.isCurrent()).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });
});

describe("exclusive (single-flight setup slot)", () => {
  it("two rapid calls while the first awaits preflight: only one runs", async () => {
    const slot = new SetupSlot();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran = vi.fn();
    const work = async (handOff: () => void) => {
      await gate; // pending host probe
      ran();
      handOff();
      return "started";
    };
    const first = exclusive(slot, "busy", work);
    const second = exclusive(slot, "busy", work);
    expect(await second).toBe("busy");
    release();
    expect(await first).toBe("started");
    expect(ran).toHaveBeenCalledTimes(1);
    expect(slot.isBusy).toBe(true); // handed off: the background run owns it
    slot.release();
    expect(slot.isBusy).toBe(false);
  });

  it("releases the slot when work is refused or throws (never handed off)", async () => {
    const slot = new SetupSlot();
    expect(await exclusive(slot, "busy", async () => "refused")).toBe("refused");
    expect(slot.isBusy).toBe(false);
    await expect(exclusive(slot, "busy", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(slot.isBusy).toBe(false);
  });
});

describe("fetchBytes", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the body on success and throws on a non-2xx", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }));
    expect(Array.from(await fetchBytes("u", ok as unknown as typeof fetch))).toEqual([1, 2]);
    const bad = vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(fetchBytes("u", bad as unknown as typeof fetch)).rejects.toThrow("404");
  });

  it("a body that trickles forever is aborted at the deadline", async () => {
    vi.useFakeTimers();
    const stall = vi.fn(async (_u: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      arrayBuffer: () => new Promise<ArrayBuffer>((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
    }));
    const p = fetchBytes("https://x/y.tgz", stall as unknown as typeof fetch, 1000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ message: expect.stringContaining("timed out") });
  });
});

describe("lockFileInFlight", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  const dead = () => false;
  const free = () => "free" as const;
  it("treats an unreadable lock (EACCES) as in flight", () => {
    expect(lockFileInFlight("/l", () => { throw err("EACCES"); }, 0, dead, free)).toBe(true);
  });
  it("treats any non-ENOENT read failure as in flight", () => {
    expect(lockFileInFlight("/l", () => { throw err("EIO"); }, 0, dead, free)).toBe(true);
  });
  it("a missing lock file means no installer", () => {
    expect(lockFileInFlight("/l", () => { throw err("ENOENT"); }, 0, dead, free)).toBe(false);
  });
  it("readable blank lock defers to the kernel probe", () => {
    expect(lockFileInFlight("/l", () => ({ content: "", mtimeMs: 0 }), 0, dead, free)).toBe(false);
    expect(lockFileInFlight("/l", () => ({ content: "", mtimeMs: 0 }), 0, dead, () => "held")).toBe(true);
  });
});
