import { describe, expect, it } from "vitest";
import {
  LocalRuntime,
  PodmanCommandError,
  WORKSPACE_IMAGE,
  machineInitArgs,
  machineProvider,
  podmanEnv,
  postgresRunArgs,
  redisRunArgs,
  workspacePaths,
  workspaceRunArgs,
  type FsOps,
  type RunResult,
  type RuntimeConfig,
} from "../src/main/localRuntime";
import type { LocalWorkspace } from "../src/main/localRegistry";

const cfg: RuntimeConfig = {
  podmanPath: "/app/podman",
  homesRoot: "/Users/u/Library/Application Support/aw/local",
  dataRoot: "/Users/u/aw-workspaces",
  path: "/app/bin:/usr/bin",
  arch: "arm64",
};
const mkWs = (id: string, uiPort = 9031, apiPort = 9032): LocalWorkspace => ({
  id, name: id, uiPort, apiPort, createdAt: "t", cloud: "none",
});
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

interface Call { cmd: string; args: string[]; env: Record<string, string> }
function harness(handler: (args: string[]) => RunResult | undefined = () => undefined, empty = true) {
  const calls: Call[] = [];
  const files: Record<string, string> = {};
  const dirs: string[] = [];
  const fs: FsOps = {
    mkdirp: (p) => void dirs.push(p),
    writeFile: (p, d) => void (files[p] = d),
    readFile: (p) => files[p] ?? null,
    isEmptyDir: () => empty,
  };
  let t = 0;
  const rt = new LocalRuntime(cfg, {
    fs,
    sleep: async () => void (t += 1000),
    now: () => t,
    newSecret: () => "s3cret",
    httpStatus: async () => 200,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      const custom = handler(args);
      if (custom) return custom;
      const j = args.join(" ");
      if (j.includes("machine list") && j.includes("{{.Running}}")) return ok("aw-localaaa true\n");
      if (j.includes("machine list")) return ok("aw-localaaa*\n");
      if (j.includes("machine ssh")) return ok("/run/user/1000/podman/podman.sock");
      if (j.includes(" exists ")) return { code: 1, stdout: "", stderr: "" };
      if (j.includes("pg_database")) return ok("");
      if (j.includes("PortBindings")) return ok("{}");
      return ok();
    },
  });
  return { rt, calls, files, dirs };
}

describe("env isolation", () => {
  it("per-workspace HOME, short TMPDIR and provider; nothing inherited", () => {
    const a = podmanEnv(cfg, "localaaa");
    const b = podmanEnv(cfg, "localbbb");
    expect(a.HOME).not.toBe(b.HOME);
    expect(a.TMPDIR).toBe("/tmp/aw-localaaa");
    expect(a.TMPDIR.length).toBeLessThan(40);
    expect(a.CONTAINERS_MACHINE_PROVIDER).toBe("libkrun");
    expect(Object.keys(a).sort()).toEqual(["CONTAINERS_MACHINE_PROVIDER", "HOME", "PATH", "TMPDIR"]);
    expect(a.HOME).not.toBe(process.env.HOME);
    expect(machineProvider("x64")).toBe("applehv");
  });
  it("every spawned podman call carries the workspace HOME/TMPDIR/provider", async () => {
    const { rt, calls } = harness();
    await rt.start(mkWs("localaaa"));
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) {
      expect(c.cmd).toBe("/app/podman");
      expect(c.env.HOME).toBe(workspacePaths(cfg, "localaaa").home);
      expect(c.env.TMPDIR).toBe("/tmp/aw-localaaa");
      expect(c.env.CONTAINERS_MACHINE_PROVIDER).toBe("libkrun");
    }
  });
  it("prepare writes containers.conf into the workspace HOME only", () => {
    const { rt, files } = harness();
    rt.prepare("localaaa");
    expect(Object.keys(files)).toEqual([`${workspacePaths(cfg, "localaaa").home}/.config/containers/containers.conf`]);
    expect(Object.values(files)[0]).toContain('provider = "libkrun"');
  });
});

describe("command construction", () => {
  it("never mentions the default machine; container calls use --connection aw-<id>", async () => {
    const { rt, calls } = harness();
    await rt.start(mkWs("localaaa"));
    expect(JSON.stringify(calls)).not.toContain("podman-machine-default");
    const nonMachine = calls.filter((c) => c.args[0] !== "machine");
    expect(nonMachine.length).toBeGreaterThan(5);
    for (const c of nonMachine) expect(c.args.slice(0, 2)).toEqual(["--connection", "aw-localaaa"]);
    const ssh = calls.find((c) => c.args.includes("ssh"));
    expect(ssh?.args.slice(0, 3)).toEqual(["machine", "ssh", "aw-localaaa"]);
  });
  it("machine init shares the data dir (HOME is overridden) and does not start", () => {
    const a = machineInitArgs(cfg, "localaaa");
    expect(a.slice(0, 3)).toEqual(["machine", "init", "aw-localaaa"]);
    expect(a).toContain("/Users/u/aw-workspaces/localaaa:/Users/u/aw-workspaces/localaaa");
  });
  it("core: loopback-only publish of apiPort, no cloud env, no chown/unshare", () => {
    const args = workspaceRunArgs({
      ws: { id: "localaaa", apiPort: 9034 },
      paths: workspacePaths(cfg, "localaaa"),
      password: "pw", socketPath: "/run/user/1000/podman/podman.sock", image: WORKSPACE_IMAGE, workers: 2,
      authPublicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n",
    });
    expect(args[args.indexOf("-p") + 1]).toBe("127.0.0.1:9034:9030");
    expect(args.filter((a) => a === "-p")).toHaveLength(1);
    const joined = args.join("\n");
    expect(joined).not.toContain("AW_BACKEND_URL");
    expect(joined).not.toContain("AW_WORKSPACE_HOST_TOKEN");
    expect(joined).not.toContain("unshare");
    expect(args).toContain("AW_WORKSPACE=localaaa");
    expect(args).toContain("AW_WORKSPACE_SCHEMA=workspace_localaaa");
    expect(args).toContain("AW_REDIS_URL=redis://aw-localaaa-redis:6379/0");
    expect(args).toContain("AW_AUTH_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n");
    expect(args).toContain("--init");
    expect(args[args.length - 1]).toBe(WORKSPACE_IMAGE);
    expect(WORKSPACE_IMAGE).toMatch(/:v\d+\.\d+\.\d+$/);
  });
  it("postgres and redis are not published to the host", () => {
    expect(postgresRunArgs("localaaa", "pw", "/d/pg")).not.toContain("-p");
    expect(redisRunArgs("localaaa", "/d/r")).not.toContain("-p");
    expect(postgresRunArgs("localaaa", "pw", "/d/pg")).toContain("aw-localaaa");
  });
  it("two workspaces never share names, homes or networks", () => {
    const a = workspacePaths(cfg, "localaaa");
    const b = workspacePaths(cfg, "localbbb");
    expect(new Set([a.home, b.home, a.tmp, b.tmp, a.data, b.data]).size).toBe(6);
    expect(redisRunArgs("localaaa", "x")).not.toEqual(redisRunArgs("localbbb", "x"));
  });
});

describe("start sequence", () => {
  it("initialises a missing machine, then postgres, redis, core in order, then health", async () => {
    const h = harness((args) => {
      const j = args.join(" ");
      if (j.includes("machine list") && j.includes("{{.Running}}")) return ok("");
      if (j.includes("machine list")) return ok("");
      return undefined;
    });
    const steps: string[] = [];
    await h.rt.start(mkWs("localaaa"), { onStep: (s) => steps.push(s) });
    const verbs = h.calls.map((c) => c.args.join(" "));
    const idx = (needle: string) => verbs.findIndex((v) => v.includes(needle));
    expect(idx("machine init")).toBeLessThan(idx("machine start"));
    expect(idx("machine start")).toBeLessThan(idx("network create"));
    const run = (n: string) => idx(`--name ${n} `);
    expect(run("aw-localaaa-postgres")).toBeGreaterThan(0);
    expect(run("aw-localaaa-postgres")).toBeLessThan(run("aw-localaaa-redis"));
    expect(run("aw-localaaa-redis")).toBeLessThan(run("aw-localaaa-workspace"));
    expect(steps).toEqual(["machine", "image", "postgres", "redis", "workspace", "health", "running"]);
    expect(h.files["/Users/u/aw-workspaces/localaaa/postgres-password"]).toBe("s3cret");
  });
  it("seeds the workspace dir from the image only when empty, with no chown", async () => {
    const empty = harness();
    await empty.rt.start(mkWs("localaaa"));
    expect(empty.calls.some((c) => c.args.includes("cp"))).toBe(true);
    const full = harness(undefined, false);
    await full.rt.start(mkWs("localaaa"));
    expect(full.calls.some((c) => c.args.includes("cp"))).toBe(false);
    expect(JSON.stringify(empty.calls)).not.toMatch(/chown|unshare/);
  });
  it("recreates the core container when the published apiPort changed", async () => {
    const h = harness((args) => {
      const j = args.join(" ");
      if (j.includes("container exists") && j.includes("-workspace")) return ok();
      if (j.includes("PortBindings")) return ok('{"9030/tcp":[{"HostIp":"127.0.0.1","HostPort":"9032"}]}');
      if (j.includes("State.Running")) return ok("true");
      return undefined;
    });
    await h.rt.start(mkWs("localaaa", 9031, 9040));
    const v = h.calls.map((c) => c.args.join(" "));
    expect(v.some((x) => x.includes("rm -f aw-localaaa-workspace"))).toBe(true);
    expect(v.some((x) => x.includes("run -d --pull=never --name aw-localaaa-workspace"))).toBe(true);
  });
  it("surfaces a failing podman call instead of swallowing it", async () => {
    const h = harness((args) => (args.includes("pull") ? { code: 125, stdout: "", stderr: "denied" } : undefined));
    const err = await h.rt.start(mkWs("localaaa")).catch((e) => e);
    expect(err).toBeInstanceOf(PodmanCommandError);
    expect(err.message).toContain("denied");
  });
  it("an `exists` probe with an unexpected exit code is an error, not 'absent'", async () => {
    const h = harness((args) => (args.includes("exists") ? { code: 125, stdout: "", stderr: "boom" } : undefined));
    await expect(h.rt.start(mkWs("localaaa"))).rejects.toBeInstanceOf(PodmanCommandError);
  });
  it("health that never turns 200 fails with a timeout", async () => {
    const calls: string[][] = [];
    let t = 0;
    const rt = new LocalRuntime(cfg, {
      fs: { mkdirp() {}, writeFile() {}, readFile: () => "pw", isEmptyDir: () => false },
      sleep: async () => void (t += 1000),
      now: () => t,
      httpStatus: async () => 0,
      run: async (_c, args) => {
        calls.push(args);
        const j = args.join(" ");
        if (j.includes("{{.Running}}")) return ok("aw-localaaa true");
        if (j.includes("machine list")) return ok("aw-localaaa");
        if (j.includes("machine ssh")) return ok("/s");
        if (j.includes(" exists ")) return { code: 1, stdout: "", stderr: "" };
        if (j.includes("pg_database")) return ok("1");
        return ok();
      },
    });
    await expect(rt.start(mkWs("localaaa"), { healthTimeoutMs: 5000 })).rejects.toThrow(/workspace health/);
  });
});

describe("stop / destroy", () => {
  it("stop stops containers then the machine; destroy removes only the machine", async () => {
    const h = harness((args) => (args.join(" ").includes(" exists ") ? ok() : undefined));
    await h.rt.stop("localaaa");
    const v = h.calls.map((c) => c.args.join(" "));
    expect(v.at(-1)).toBe("machine stop aw-localaaa");
    await h.rt.destroy("localaaa");
    expect(h.calls.at(-1)?.args).toEqual(["machine", "rm", "--force", "aw-localaaa"]);
  });
});
