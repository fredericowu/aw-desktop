import { describe, expect, it, vi } from "vitest";
import { SetupSlot, bootstrapArgs, childEnv, exclusive, readHostStatus, runBootstrapFlow, type FlowDeps, type HostOps } from "../src/main/localBootstrap";
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
    const { d } = deps(o);
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

describe("childEnv", () => {
  it("gives the CLI the dirs where Desktop's runtime probe finds Podman", () => {
    const env = childEnv({ PATH: "/usr/bin:/bin" }, "/Users/me");
    const dirs = env.PATH!.split(":");
    expect(dirs).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/Users/me/podman-dist/podman/bin", "/Users/me/.local/bin"]));
    expect(dirs.slice(-2)).toEqual(["/usr/bin", "/bin"]);
  });
  it("does not duplicate dirs already on PATH and keeps other vars", () => {
    const env = childEnv({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me" }, "/Users/me");
    expect(env.PATH!.split(":").filter((d) => d === "/opt/homebrew/bin").length).toBe(1);
    expect(env.HOME).toBe("/Users/me");
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
