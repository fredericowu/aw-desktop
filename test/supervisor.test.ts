import { vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/aw-test-userdata" } }));
import { describe, expect, it } from "vitest";
import { Supervisor, type RecoverOutcome, type SupervisedStatus } from "../src/main/supervisorCore";
import { LocalRuntime, type FsOps, type RunResult, type RuntimeConfig } from "../src/main/localRuntime";
import type { LocalWorkspace } from "../src/main/localRegistry";
import { LocalWorkspaces, toWorkspaceInfo } from "../src/main/localWorkspaces";
import { SUPERVISOR_COPY } from "../src/shared/errorCopy";


// ---- Supervisor state machine ----
function mk(opts: { health?: (id: string) => boolean; recover?: (id: string) => Promise<RecoverOutcome> } = {}) {
  let t = 1_000_000;
  const statuses: Array<[string, SupervisedStatus]> = [];
  const failures: unknown[] = [];
  let recoverCalls = 0;
  const sup = new Supervisor(
    {
      healthy: async (id) => (opts.health ?? (() => true))(id),
      recover: async (id) => {
        recoverCalls++;
        return (opts.recover ?? (async () => "ok" as const))(id);
      },
      onStatus: (id, s) => void statuses.push([id, s]),
      onFailure: (_id, e) => void failures.push(e),
      now: () => t,
    },
    { failThreshold: 2, maxAttempts: 3, backoffMs: [1000, 2000, 4000] },
  );
  return { sup, statuses, failures, calls: () => recoverCalls, advance: (ms: number) => void (t += ms) };
}

describe("Supervisor", () => {
  it("does nothing while health answers", async () => {
    const h = mk();
    h.sup.watch("a");
    await h.sup.tick();
    await h.sup.tick();
    expect(h.calls()).toBe(0);
    expect(h.statuses).toEqual([]);
  });

  it("API stops answering: one dropped poll is tolerated, the second starts recovery and shows starting then running", async () => {
    let up = false;
    const h = mk({ health: () => up, recover: async () => ((up = true), "ok") });
    h.sup.watch("a");
    await h.sup.tick();
    expect(h.calls()).toBe(0);
    await h.sup.tick();
    expect(h.calls()).toBe(1);
    expect(h.statuses).toEqual([["a", "starting"], ["a", "running"]]);
  });

  it("VM dies: recovery failing repeatedly backs off between attempts, then needs attention after 3", async () => {
    const h = mk({ health: () => false, recover: async () => { throw new Error("vm gone"); } });
    h.sup.watch("a");
    await h.sup.tick(); // miss 1
    await h.sup.tick(); // miss 2 -> attempt 1 fails
    expect(h.calls()).toBe(1);
    await h.sup.tick(); // inside the 1000ms backoff: no attempt
    expect(h.calls()).toBe(1);
    h.advance(1000);
    await h.sup.tick(); // attempt 2 fails
    expect(h.calls()).toBe(2);
    h.advance(1999);
    await h.sup.tick(); // still inside the 2000ms backoff
    expect(h.calls()).toBe(2);
    h.advance(1);
    await h.sup.tick(); // attempt 3 fails -> needs attention
    expect(h.calls()).toBe(3);
    expect(h.sup.status("a")).toBe("needs_attention");
    expect(h.failures).toHaveLength(3);
    h.advance(1_000_000);
    await h.sup.tick();
    await h.sup.tick();
    expect(h.calls()).toBe(3); // stays put until the user retries
  });

  it("a successful retry (watch again) clears needs attention and resumes supervision", async () => {
    const h = mk({ health: () => false, recover: async () => { throw new Error("x"); } });
    h.sup.watch("a");
    for (let i = 0; i < 12; i++) { await h.sup.tick(); h.advance(10_000); }
    expect(h.sup.status("a")).toBe("needs_attention");
    h.sup.watch("a");
    expect(h.sup.status("a")).toBe("running");
  });

  it("user-initiated stop is NOT auto-restarted (unwatched workspaces are never probed or recovered)", async () => {
    const h = mk({ health: () => false });
    h.sup.watch("a");
    h.sup.unwatch("a");
    await h.sup.tick();
    await h.sup.tick();
    await h.sup.tick();
    expect(h.calls()).toBe(0);
    expect(h.statuses).toEqual([]);
  });

  it("a stop that lands while the health probe is in flight cancels the recovery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const sup = new Supervisor({
      healthy: async () => (await gate, false),
      recover: async () => (calls++, "ok"),
      onStatus() {},
      onFailure() {},
    }, { failThreshold: 1 });
    sup.watch("a");
    const p = sup.tick();
    sup.unwatch("a"); // user stops it while the probe is pending
    release();
    await p;
    expect(calls).toBe(0);
  });

  it("a stop that lands during recovery leaves no status behind and counts no attempt", async () => {
    const h = mk({ health: () => false, recover: async () => { h.sup.unwatch("a"); throw new Error("stopped mid-recovery"); } });
    h.sup.watch("a");
    await h.sup.tick();
    await h.sup.tick();
    expect(h.failures).toEqual([]);
    expect(h.sup.status("a")).toBeNull();
  });

  it("a busy setup slot is retried next tick and consumes no attempt", async () => {
    let busy = true;
    const h = mk({ health: () => false, recover: async () => (busy ? "busy" : "ok") });
    h.sup.watch("a");
    for (let i = 0; i < 6; i++) await h.sup.tick();
    expect(h.sup.status("a")).toBe("starting");
    expect(h.failures).toEqual([]);
    busy = false;
    await h.sup.tick();
    expect(h.sup.status("a")).toBe("running");
  });

  it("never runs two recoveries for one workspace at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const sup = new Supervisor({
      healthy: async () => false,
      recover: async () => (calls++, await gate, "ok"),
      onStatus() {},
      onFailure() {},
    }, { failThreshold: 1 });
    sup.watch("a");
    const first = sup.tick();
    await Promise.resolve();
    await sup.tick();
    release();
    await first;
    expect(calls).toBe(1);
  });

  it("supervises workspaces independently", async () => {
    const h = mk({ health: (id) => id !== "bad", recover: async () => { throw new Error("x"); } });
    h.sup.watch("good");
    h.sup.watch("bad");
    await h.sup.tick();
    await h.sup.tick();
    expect(h.sup.status("good")).toBe("running");
    expect(h.calls()).toBe(1);
  });
});

describe("row status", () => {
  const rec: LocalWorkspace = { id: "localaaa", name: "Box", sub: "1", uiPort: 9031, apiPort: 9032, createdAt: "t", cloud: "none" };
  it("maps supervised states to plain copy and never to engine wording", () => {
    expect(toWorkspaceInfo(rec, true, "starting")).toMatchObject({ status: "starting", detail: SUPERVISOR_COPY.starting });
    expect(toWorkspaceInfo(rec, true, "needs_attention")).toMatchObject({ status: "needs_attention", detail: SUPERVISOR_COPY.needs_attention });
    expect(toWorkspaceInfo(rec, true, "running").status).toBe("running");
    expect(toWorkspaceInfo(rec, false, "starting").status).toBe("stopped");
  });
});

// ---- LocalRuntime recovery mode ----
const cfg: RuntimeConfig = { podmanPath: "/app/podman", homesRoot: "/h", dataRoot: "/d", path: "/app", arch: "arm64" };
const ws: LocalWorkspace = { id: "localaaa", name: "x", sub: "s", uiPort: 9031, apiPort: 9032, createdAt: "t", cloud: "none" };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

function rtHarness(o: { machineRunning: boolean; engineUp: boolean; coreRunning: boolean; health: () => number }) {
  const cmds: string[] = [];
  const removed: string[] = [];
  const fs: FsOps = { mkdirp() {}, writeFile() {}, readFile: () => "pw", isEmptyDir: () => false, rmrf: (p) => void removed.push(p) };
  let t = 0;
  const rt = new LocalRuntime({ ...cfg, tmpRoot: "/tmp" }, {
    fs,
    sleep: async () => void (t += 1000),
    now: () => t,
    httpStatus: async () => o.health(),
    run: async (_c, args) => {
      const j = args.join(" ");
      cmds.push(j);
      if (j.includes("machine list") && j.includes("{{.Running}}")) return ok(`aw-localaaa ${o.machineRunning}\n`);
      if (j.includes("machine list")) return ok("aw-localaaa*\n");
      if (j.endsWith(" info")) return o.engineUp ? ok() : { code: 125, stdout: "", stderr: "Cannot connect to Podman" };
      if (j.includes("machine ssh")) return ok("/run/user/1000/podman/podman.sock");
      if (j.includes("State.Running")) return ok(String(o.coreRunning));
      if (j.includes("PortBindings")) return ok('{"9030/tcp":[{"HostIp":"127.0.0.1","HostPort":"9032"}]}');
      if (j.includes("pg_database")) return ok("1");
      if (j.includes(" exists ")) return ok(); // everything already exists
      return ok();
    },
  });
  return { rt, cmds, removed };
}

describe("LocalRuntime recovery", () => {
  it("hung core: VM and container running but health fails -> container is restarted, then health passes", async () => {
    let restarted = false;
    const h = rtHarness({ machineRunning: true, engineUp: true, coreRunning: true, health: () => (restarted ? 200 : 0) });
    const run = h.rt as unknown as { run: (c: string, a: string[], o: unknown) => Promise<RunResult> };
    const orig = run.run;
    run.run = async (c, a, o) => {
      if (a.includes("restart")) restarted = true;
      return orig(c, a, o);
    };
    await h.rt.start(ws, { recover: true });
    expect(h.cmds.some((c) => c.includes("restart aw-localaaa-workspace"))).toBe(true);
    expect(h.cmds.some((c) => c.includes("machine start"))).toBe(false);
  });

  it("a normal start does NOT restart a running core (today's behaviour is kept)", async () => {
    const h = rtHarness({ machineRunning: true, engineUp: true, coreRunning: true, health: () => 200 });
    await h.rt.start(ws);
    expect(h.cmds.some((c) => c.includes(" restart "))).toBe(false);
  });

  it("recovery leaves a healthy running core alone", async () => {
    const h = rtHarness({ machineRunning: true, engineUp: true, coreRunning: true, health: () => 200 });
    await h.rt.start(ws, { recover: true });
    expect(h.cmds.some((c) => c.includes(" restart "))).toBe(false);
  });

  it("VM killed but still marked running (engine unreachable): stop, clear stale sockets, start again", async () => {
    const h = rtHarness({ machineRunning: true, engineUp: false, coreRunning: true, health: () => 200 });
    await h.rt.start(ws, { recover: true });
    const stop = h.cmds.findIndex((c) => c.startsWith("machine stop aw-localaaa"));
    const start = h.cmds.findIndex((c) => c.startsWith("machine start aw-localaaa"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(stop);
    expect(h.removed.filter((p) => p.endsWith(".sock")).length).toBe(3);
  });

  it("VM stopped: recovery starts it (sockets cleared) and never removes or re-creates it", async () => {
    const h = rtHarness({ machineRunning: false, engineUp: true, coreRunning: true, health: () => 200 });
    await h.rt.start(ws, { recover: true });
    expect(h.cmds.some((c) => c.startsWith("machine start aw-localaaa"))).toBe(true);
    expect(h.cmds.some((c) => /machine (rm|init)|volume rm|system reset/.test(c))).toBe(false);
  });

  it("recovery that cannot start the VM throws (the supervisor counts it) and removes nothing", async () => {
    const h = rtHarness({ machineRunning: false, engineUp: true, coreRunning: true, health: () => 200 });
    const run = h.rt as unknown as { run: (c: string, a: string[], o: unknown) => Promise<RunResult> };
    const orig = run.run;
    run.run = async (c, a, o) => (a.join(" ").startsWith("machine start") ? { code: 125, stdout: "", stderr: "unable to connect to gvproxy socket" } : orig(c, a, o));
    await expect(h.rt.start(ws, { recover: true })).rejects.toThrow(/gvproxy/);
    expect(h.cmds.some((c) => /machine (rm|init)/.test(c))).toBe(false);
  });
});

// ---- LocalWorkspaces wiring (review round 1) ----
describe("LocalWorkspaces supervision wiring", () => {
  const rec: LocalWorkspace = { id: "localaaa", name: "Box", sub: "1", uiPort: 9031, apiPort: 9032, createdAt: "t", cloud: "none" };
  const make = () => {
    const w = new LocalWorkspaces(() => null, async () => undefined);
    vi.spyOn(w.registry, "get").mockReturnValue(rec);
    vi.spyOn(w.registry, "reconcilePorts").mockResolvedValue({ workspace: rec } as never);
    return w;
  };

  it("Retry after needs attention starts in recovery mode (restarts a running-but-hung core)", async () => {
    const w = make();
    const start = vi.spyOn(w.runtime, "start").mockRejectedValue(new Error("stop here"));
    vi.spyOn(w, "needsAttention").mockReturnValue(true);
    await expect(w.start("localaaa", "k", () => undefined)).rejects.toThrow("stop here");
    expect(start.mock.calls[0][1]).toMatchObject({ recover: true });
    vi.spyOn(w, "needsAttention").mockReturnValue(false);
    await expect(w.start("localaaa", "k", () => undefined)).rejects.toThrow("stop here");
    expect(start.mock.calls[1][1]).toMatchObject({ recover: false });
  });

  it("quit waits for a recovery that is mid-start and then stops what it started", async () => {
    const w = make();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(w.runtime, "start").mockImplementation(async () => (order.push("start"), await gate, order.push("started")));
    vi.spyOn(w.runtime, "stop").mockImplementation(async () => void order.push("stop"));
    (w as unknown as { running: Set<string> }).running.add("localaaa");
    w.startSupervisor({ exclusive: async (work) => (await work(), "ok"), onStatus() {}, onFailure() {}, authKey: async () => "k" }, 3_600_000);
    const sup = (w as unknown as { supervisor: Supervisor }).supervisor;
    sup.watch("localaaa");
    const rec1 = (w as unknown as { recover(id: string): Promise<RecoverOutcome> }).recover("localaaa");
    await new Promise((r) => setTimeout(r, 0));
    const quit = w.stopAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start"]); // stop must not run while recovery is mid-start
    release();
    await Promise.all([rec1.catch(() => undefined), quit]);
    expect(order).toEqual(["start", "started", "stop"]);
  });

  it("recovery that has not started yet does nothing once quit began", async () => {
    const w = make();
    const start = vi.spyOn(w.runtime, "start").mockResolvedValue();
    w.startSupervisor({ exclusive: async (work) => (await work(), "ok"), onStatus() {}, onFailure() {}, authKey: async () => "k" }, 3_600_000);
    await w.stopAll();
    await (w as unknown as { recover(id: string): Promise<RecoverOutcome> }).recover("localaaa");
    expect(start).not.toHaveBeenCalled();
  });
});

describe("banner Retry joins the shutdown lifecycle", () => {
  const rec: LocalWorkspace = { id: "localaaa", name: "Box", sub: "1", uiPort: 9031, apiPort: 9032, createdAt: "t", cloud: "none" };
  const make = () => {
    const w = new LocalWorkspaces(() => null, async () => undefined);
    vi.spyOn(w.registry, "get").mockReturnValue(rec);
    vi.spyOn(w.registry, "reconcilePorts").mockResolvedValue({ workspace: rec } as never);
    return w;
  };

  it("quit while Retry waits for the key: no runtime work starts", async () => {
    const w = make();
    const start = vi.spyOn(w.runtime, "start").mockResolvedValue();
    let release!: (k: string) => void;
    const key = new Promise<string>((r) => (release = r));
    const retry = w.retry("localaaa", () => key);
    const quit = w.stopAll(); // waits for the held Retry
    release("k");
    expect(await retry).toBe(false);
    await quit;
    expect(start).not.toHaveBeenCalled();
  });

  it("quit during a Retry that is mid-start waits for it, then stops what it started", async () => {
    const w = make();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(w.runtime, "start").mockImplementation(async () => (order.push("start"), await gate, order.push("started")));
    vi.spyOn(w.runtime, "stop").mockImplementation(async () => void order.push("stop"));
    (w as unknown as { running: Set<string> }).running.add("localaaa");
    const retry = w.retry("localaaa", async () => "k");
    await new Promise((r) => setTimeout(r, 0));
    const quit = w.stopAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start"]);
    release();
    await Promise.all([retry, quit]);
    expect(order).toEqual(["start", "started", "stop"]);
  });

  it("Retry after quit began resolves false without calling the key provider", async () => {
    const w = make();
    await w.stopAll();
    const key = vi.fn(async () => "k");
    expect(await w.retry("localaaa", key)).toBe(false);
    expect(key).not.toHaveBeenCalled();
  });
});

// ---- production default pin (QA: 3 -> 4 still passed the targeted test) ----
describe("Supervisor production defaults", () => {
  it("needs attention after EXACTLY 3 failed recovery attempts with no options passed", async () => {
    let t = 1_000_000;
    let calls = 0;
    const statuses: SupervisedStatus[] = [];
    const sup = new Supervisor({
      healthy: async () => false,
      recover: async () => {
        calls++;
        throw new Error("boom");
      },
      onStatus: (_id, s) => void statuses.push(s),
      onFailure: () => undefined,
      now: () => t,
    });
    sup.watch("w");
    for (let i = 0; i < 20 && sup.status("w") !== "needs_attention"; i++) {
      await sup.tick();
      t += 10 * 60_000; // far past any backoff
    }
    expect(calls).toBe(3);
    expect(sup.status("w")).toBe("needs_attention");
  });
});
