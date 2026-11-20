import { describe, expect, it, vi } from "vitest";
import { readHostStatus, runBootstrapFlow, type FlowDeps, type HostOps } from "../src/main/localBootstrap";
import type { BootstrapProgress } from "../src/shared/types";

function ops(over: Partial<HostOps> = {}): HostOps {
  return {
    findBinary: () => "/bin/arh",
    hasCredentials: () => false,
    runStatus: async () => "linked: no (no credentials found)",
    installBinary: vi.fn(async () => "/home/.local/bin/aw-remote-host"),
    runBootstrap: vi.fn(async (_b, _t, onLine) => {
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
    expect(o.runBootstrap).toHaveBeenCalledWith("/bin/arh", "awbs_secret_token", expect.any(Function));
    expect(JSON.stringify(events)).not.toContain("awbs_secret_token");
  });

  it("installs the pinned binary only when none exists", async () => {
    const o = ops({ findBinary: vi.fn().mockReturnValueOnce(null).mockReturnValue(null) });
    const { d } = deps(o);
    await runBootstrapFlow("w", d);
    expect(o.installBinary).toHaveBeenCalledTimes(1);
    expect(o.runBootstrap).toHaveBeenCalledWith("/home/.local/bin/aw-remote-host", "awbs_secret_token", expect.any(Function));
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
    expect(o.runBootstrap).toHaveBeenCalledWith("/bin/arh", null, expect.any(Function));
  });

  it("CLI failure reports the failing step and the last log lines", async () => {
    const o = ops({
      runBootstrap: async (_b, _t, onLine) => {
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
