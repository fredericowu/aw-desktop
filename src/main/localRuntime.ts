// Per-workspace podman runtime for standalone local workspaces (card 41f5bf3b,
// design v2 + Mac spike run 693a0c89). No electron imports; every process spawn
// goes through an injectable Runner so command construction is unit-testable.
//
// Spike facts this encodes:
//  - podman allows ONE running VM per HOME ("only one VM can be active at a
//    time"), so each workspace gets its own HOME, its own short TMPDIR (macOS
//    unix-socket path limit) and CONTAINERS_MACHINE_PROVIDER. The user's own
//    default machine / HOME is never involved.
//  - `podman unshare chown` does not exist on the remote client and was not
//    needed (virtiofs bind mounts). Nothing here chowns.
//  - core boots healthy with AW_BACKEND_URL / AW_WORKSPACE_HOST_TOKEN unset.
import { execFile } from "node:child_process";
import { get as httpGet } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { LocalWorkspace } from "./localRegistry";

/** Pinned public tag (spike verified v0.158.0). Not `latest`: the bundled UI must match the core. */
export const WORKSPACE_IMAGE = "ghcr.io/fredericowu/aw-workspace:v0.158.0";
// Same pinned digests as aw-remote-host bootstrap/{postgres,redis}/install.sh.
export const POSTGRES_IMAGE =
  "docker.io/pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb";
export const REDIS_IMAGE =
  "docker.io/library/redis@sha256:a8f08480e1f88f2647fed492d1178c06abb0d0c1fbf02c682a61e2f483fb3954";

const CONTAINER_WORKDIR = "/opt/aw-workspace";
const CONTAINER_HOME = "/home/ubuntu";
const CONTAINER_SOCK = "/run/podman.sock";
const CORE_PORT = 9030; // port INSIDE the container; the host side is apiPort

export interface RunOpts {
  /** The COMPLETE environment for the child: nothing is inherited. */
  env: Record<string, string>;
  timeoutMs?: number;
}
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], opts: RunOpts) => Promise<RunResult>;

export class PodmanCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: RunResult,
  ) {
    super(`podman ${args.slice(0, 4).join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "PodmanCommandError";
  }
}

export const execRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: opts.env, timeout: opts.timeoutMs ?? 0, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: err && !stderr ? String(err.message) : String(stderr) });
      },
    );
  });

export interface FsOps {
  mkdirp(p: string): void;
  writeFile(p: string, data: string, mode?: number): void;
  readFile(p: string): string | null;
  isEmptyDir(p: string): boolean;
  /** Recursive, forced delete; a missing path is not an error. */
  rmrf(p: string): void;
}
export const realFs: FsOps = {
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  writeFile: (p, d, mode) => writeFileSync(p, d, mode ? { mode } : undefined),
  readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  isEmptyDir: (p) => {
    try {
      return readdirSync(p).length === 0;
    } catch (err) {
      // Only a genuinely absent path counts as empty; EACCES etc. must not look like "nothing here".
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return true;
      throw err;
    }
  },
  rmrf: (p) => rmSync(p, { recursive: true, force: true }),
};

export interface RuntimeConfig {
  /** Absolute path of the podman binary (vendored or system). */
  podmanPath: string;
  /** App data dir: per-workspace podman HOMEs live under <homesRoot>/<id>/home. */
  homesRoot: string;
  /** Workspace data root, e.g. ~/aw-workspaces. Must be under the real $HOME or shared into the VM. */
  dataRoot: string;
  /** Short dir for TMPDIR (default /tmp). Per workspace: <tmpRoot>/aw-<id>. */
  tmpRoot?: string;
  /** PATH handed to podman (gvproxy/vfkit/krunkit live next to it). */
  path: string;
  arch?: string;
  image?: string;
  workers?: number;
  machine?: { cpus?: number; memoryMiB?: number; diskGiB?: number };
}

export interface RuntimeDeps {
  run?: Runner;
  fs?: FsOps;
  /** HTTP status of GET url, or 0 on connection failure. */
  httpStatus?: (url: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  newSecret?: () => string;
  now?: () => number;
}

export const machineName = (id: string) => `aw-${id}`;
export const networkName = (id: string) => `aw-${id}`;
export const containerNames = (id: string) => ({
  postgres: `aw-${id}-postgres`,
  redis: `aw-${id}-redis`,
  workspace: `aw-${id}-workspace`,
});

export interface WorkspacePaths {
  home: string; // podman HOME (NOT the user's)
  tmp: string;
  data: string;
  workspace: string;
  homeData: string;
  postgres: string;
  redis: string;
  passwordFile: string;
}

export function workspacePaths(cfg: RuntimeConfig, id: string): WorkspacePaths {
  const data = join(cfg.dataRoot, id);
  return {
    home: join(cfg.homesRoot, id, "home"),
    tmp: join(cfg.tmpRoot ?? "/tmp", `aw-${id}`),
    data,
    workspace: join(data, "workspace"),
    homeData: join(data, "home"),
    postgres: join(data, "postgres"),
    redis: join(data, "redis"),
    passwordFile: join(data, "postgres-password"),
  };
}

export function machineProvider(arch: string = process.arch): string {
  return arch === "arm64" ? "libkrun" : "applehv";
}

/** The ONLY env podman ever sees: own HOME, short TMPDIR, provider, and the bundled helper dir.
 * Nothing inherited (no CONTAINER_HOST etc.). CONTAINERS_HELPER_BINARY_DIR makes podman take
 * gvproxy/vfkit/krunkit from the signed engine next to it; without it podman searches its default
 * helper dirs first (Homebrew's), so a Mac with brew podman would boot the VM with unbundled helpers. */
export function podmanEnv(cfg: RuntimeConfig, id: string): Record<string, string> {
  const p = workspacePaths(cfg, id);
  return {
    HOME: p.home,
    TMPDIR: p.tmp,
    PATH: cfg.path,
    CONTAINERS_MACHINE_PROVIDER: machineProvider(cfg.arch),
    CONTAINERS_HELPER_BINARY_DIR: dirname(cfg.podmanPath),
  };
}

export function containersConf(cfg: RuntimeConfig): string {
  return `[machine]\nprovider = "${machineProvider(cfg.arch)}"\n`;
}

// ---- pure argument builders (no connection prefix; LocalRuntime adds it) ----

export function machineInitArgs(cfg: RuntimeConfig, id: string): string[] {
  const m = cfg.machine ?? {};
  const p = workspacePaths(cfg, id);
  return [
    "machine", "init", machineName(id),
    "--cpus", String(m.cpus ?? 2),
    "--memory", String(m.memoryMiB ?? 4096),
    "--disk-size", String(m.diskGiB ?? 40),
    // HOME is the per-workspace one, so podman's default $HOME:$HOME share would
    // not cover the data dir. Share it explicitly (virtiofs, same path in the VM).
    "--volume", `${p.data}:${p.data}`,
    "--now=false",
  ];
}

export function postgresRunArgs(id: string, password: string, dataDir: string): string[] {
  const n = containerNames(id);
  return [
    "run", "-d", "--name", n.postgres, "--network", networkName(id),
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-v", `${dataDir}:/var/lib/postgresql/data`,
    POSTGRES_IMAGE,
  ];
}

export function redisRunArgs(id: string, dataDir: string): string[] {
  const n = containerNames(id);
  return [
    "run", "-d", "--name", n.redis, "--network", networkName(id),
    "-v", `${dataDir}:/data`,
    REDIS_IMAGE, "redis-server", "--appendonly", "yes",
  ];
}

export interface WorkspaceRunInput {
  ws: Pick<LocalWorkspace, "id" | "apiPort">;
  paths: Pick<WorkspacePaths, "workspace" | "homeData">;
  password: string;
  socketPath: string;
  image: string;
  workers: number;
  authPublicKey?: string;
}

export function workspaceEnvVars(i: WorkspaceRunInput): string[] {
  const n = containerNames(i.ws.id);
  const db = `postgresql+psycopg://postgres:${i.password}@${n.postgres}:5432/aw_workspace`;
  const vars: Record<string, string> = {
    AW_WORKSPACE: i.ws.id,
    AW_WORKSPACE_SCHEMA: `workspace_${i.ws.id}`,
    AWSERV_DB_URL: db,
    AW_WORKSPACE_DB_URL: db,
    AW_REDIS_URL: `redis://${n.redis}:6379/0`,
    AW_WORKSPACE_HOST_DIR: i.paths.workspace,
    AW_WORKSPACE_CONTAINER_DIR: CONTAINER_WORKDIR,
    AW_WORKSPACE_HOME_HOST_DIR: i.paths.homeData,
    AW_CONTAINER_SOCKET: CONTAINER_SOCK,
    AW_CONTAINER_NETWORK: networkName(i.ws.id),
    AW_WORKSPACE_WORKERS: String(i.workers),
  };
  // Standalone: AW_BACKEND_URL and AW_WORKSPACE_HOST_TOKEN are deliberately never set.
  if (i.authPublicKey) vars.AW_AUTH_PUBLIC_KEY = i.authPublicKey;
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`);
}

export function workspaceRunArgs(i: WorkspaceRunInput): string[] {
  const n = containerNames(i.ws.id);
  const args = [
    "run", "-d", "--pull=never", "--name", n.workspace, "--network", networkName(i.ws.id),
    "--restart=always", "--init", "--ulimit", "core=0",
    // Loopback only, never 0.0.0.0.
    "-p", `127.0.0.1:${i.ws.apiPort}:${CORE_PORT}`,
    "-v", `${i.paths.workspace}:${CONTAINER_WORKDIR}`,
    "-v", `${i.paths.homeData}:${CONTAINER_HOME}`,
    "-v", `${i.socketPath}:${CONTAINER_SOCK}`,
    "--security-opt", "label=disable",
  ];
  for (const e of workspaceEnvVars(i)) args.push("-e", e);
  args.push(i.image);
  return args;
}

const defaultStatus = (url: string): Promise<number> =>
  new Promise((resolve) => {
    const req = httpGet(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => (req.destroy(), resolve(0)));
  });

export interface StartOptions {
  authPublicKey?: string;
  /** Called with a short step name as bring-up progresses. */
  onStep?: (step: string) => void;
  healthTimeoutMs?: number;
  /** Supervisor recovery (ADR 0001, decision 3). A normal start leaves a running container alone;
   * recovery restarts a running-but-unhealthy core, and treats a VM that reports running while its
   * engine does not answer as dead. Never removes or re-creates a VM. */
  recover?: boolean;
}

export class LocalRuntime {
  private readonly run: Runner;
  private readonly fs: FsOps;
  private readonly status: (url: string) => Promise<number>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secret: () => string;
  private readonly clock: () => number;

  constructor(
    private readonly cfg: RuntimeConfig,
    deps: RuntimeDeps = {},
  ) {
    this.run = deps.run ?? execRunner;
    this.fs = deps.fs ?? realFs;
    this.status = deps.httpStatus ?? defaultStatus;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.secret = deps.newSecret ?? (() => randomBytes(18).toString("hex"));
    this.clock = deps.now ?? Date.now;
  }

  /** HTTP status of the core's health URL on `apiPort` (0 when it does not answer). */
  healthStatus(apiPort: number): Promise<number> {
    return this.status(`http://127.0.0.1:${apiPort}/api/health`);
  }

  /** Raw podman call under this workspace's isolated env. Resolves with the result whatever the exit code. */
  private raw(id: string, args: string[], timeoutMs?: number): Promise<RunResult> {
    return this.run(this.cfg.podmanPath, args, { env: podmanEnv(this.cfg, id), timeoutMs });
  }
  /** Container-engine call: explicit --connection, throws on non-zero (nothing is swallowed). */
  private async pm(id: string, args: string[], timeoutMs?: number): Promise<RunResult> {
    const full = ["--connection", machineName(id), ...args];
    const r = await this.raw(id, full, timeoutMs);
    if (r.code !== 0) throw new PodmanCommandError(full, r);
    return r;
  }
  /** Exit-code-as-answer probe (`container exists`, `network exists`): 0 = yes, 1 = no, anything else is an error. */
  private async exists(id: string, args: string[]): Promise<boolean> {
    const full = ["--connection", machineName(id), ...args];
    const r = await this.raw(id, full);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new PodmanCommandError(full, r);
  }
  private async machineCmd(id: string, args: string[], timeoutMs?: number): Promise<RunResult> {
    const r = await this.raw(id, args, timeoutMs);
    if (r.code !== 0) throw new PodmanCommandError(args, r);
    return r;
  }

  /** Create the isolated HOME/TMPDIR/data dirs and the per-HOME containers.conf. Idempotent. */
  prepare(id: string): WorkspacePaths {
    const p = workspacePaths(this.cfg, id);
    for (const d of [p.home, p.tmp, p.data, p.workspace, p.homeData, p.postgres, p.redis]) this.fs.mkdirp(d);
    const confDir = join(p.home, ".config", "containers");
    this.fs.mkdirp(confDir);
    this.fs.writeFile(join(confDir, "containers.conf"), containersConf(this.cfg));
    return p;
  }

  // ---- machine lifecycle ----
  async machineExists(id: string): Promise<boolean> {
    const r = await this.machineCmd(id, ["machine", "list", "--format", "{{.Name}}"]);
    return r.stdout.split("\n").some((l) => l.trim().replace(/\*$/, "") === machineName(id));
  }
  async machineRunning(id: string): Promise<boolean> {
    const r = await this.machineCmd(id, ["machine", "list", "--format", "{{.Name}} {{.Running}}"]);
    return r.stdout.split("\n").some((l) => {
      const [n, running] = l.trim().split(/\s+/);
      return n?.replace(/\*$/, "") === machineName(id) && running === "true";
    });
  }
  async machineInit(id: string): Promise<void> {
    this.prepare(id);
    await this.machineCmd(id, machineInitArgs(this.cfg, id), 600_000);
  }
  async machineStart(id: string): Promise<void> {
    const p = this.prepare(id); // /tmp is wiped on reboot: TMPDIR must exist at every start
    // gvproxy >= 0.9.0 no longer removes a leftover socket before listening, so a socket left by a
    // killed or crashed VM (or by an older gvproxy's stop) makes `machine start` fail with "unable to
    // connect to gvproxy socket". Callers only reach here when the VM is not running; the dir is this
    // workspace's own TMPDIR, so only its own sockets are touched.
    const n = machineName(id);
    for (const sock of [`${n}-gvproxy.sock`, `${n}-api.sock`, `${n}.sock`]) this.fs.rmrf(join(p.tmp, "podman", sock));
    await this.machineCmd(id, ["machine", "start", machineName(id)], 300_000);
  }
  async machineStop(id: string): Promise<void> {
    await this.machineCmd(id, ["machine", "stop", machineName(id)], 120_000);
  }
  async machineRemove(id: string): Promise<void> {
    await this.machineCmd(id, ["machine", "rm", "--force", machineName(id)], 120_000);
  }

  // ---- containers ----
  /** Podman API socket path INSIDE the VM; the machine name is a parameter, never podman-machine-default. */
  async vmSocketPath(id: string): Promise<string> {
    const script = 'sock="/run/user/$(id -u)/podman/podman.sock"; test -S "$sock" && printf %s "$sock"';
    const r = await this.machineCmd(id, ["machine", "ssh", machineName(id), script]);
    const sock = r.stdout.trim();
    if (!sock) throw new Error(`podman socket not found inside machine ${machineName(id)}`);
    return sock;
  }

  private async password(paths: WorkspacePaths): Promise<string> {
    const cur = this.fs.readFile(paths.passwordFile)?.trim();
    if (cur) return cur;
    const pw = this.secret();
    this.fs.writeFile(paths.passwordFile, pw, 0o600);
    return pw;
  }

  private async ensureNetwork(id: string): Promise<void> {
    if (!(await this.exists(id, ["network", "exists", networkName(id)]))) {
      await this.pm(id, ["network", "create", networkName(id)]);
    }
  }
  private async pullIfMissing(id: string, image: string): Promise<void> {
    if (!(await this.exists(id, ["image", "exists", image]))) await this.pm(id, ["pull", image], 1_800_000);
  }
  /** Start an existing container or create it. */
  private async ensureContainer(id: string, name: string, runArgs: string[]): Promise<void> {
    if (await this.exists(id, ["container", "exists", name])) {
      const st = await this.pm(id, ["inspect", name, "--format", "{{.State.Running}}"]);
      if (st.stdout.trim() !== "true") await this.pm(id, ["start", name]);
    } else {
      await this.pm(id, runArgs);
    }
  }
  /** True when the engine inside the VM answers. */
  private async engineReachable(id: string): Promise<boolean> {
    return (await this.raw(id, ["--connection", machineName(id), "info"], 30_000)).code === 0;
  }
  private async containerRunning(id: string, name: string): Promise<boolean> {
    if (!(await this.exists(id, ["container", "exists", name]))) return false;
    return (await this.pm(id, ["inspect", name, "--format", "{{.State.Running}}"])).stdout.trim() === "true";
  }
  private async waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const end = this.clock() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (this.clock() >= end) throw new Error(`${what}: not ready after ${Math.round(timeoutMs / 1000)}s`);
      await this.sleep(1000);
    }
  }

  async seedWorkspaceDir(id: string, image: string, paths: WorkspacePaths): Promise<boolean> {
    if (!this.fs.isEmptyDir(paths.workspace)) return false;
    const seed = `aw-${id}-seed`;
    await this.pm(id, ["create", "--pull=never", "--name", seed, image]);
    try {
      await this.pm(id, ["cp", `${seed}:${CONTAINER_WORKDIR}/.`, paths.workspace]);
    } finally {
      await this.pm(id, ["rm", "-f", seed]);
    }
    return true;
  }

  /** Bring everything up in order: machine, network, postgres, redis, core, health. Surfaces every failure. */
  async start(ws: LocalWorkspace, opts: StartOptions = {}): Promise<void> {
    const id = ws.id;
    const step = opts.onStep ?? (() => undefined);
    const image = this.cfg.image ?? WORKSPACE_IMAGE;
    const paths = this.prepare(id);
    const names = containerNames(id);

    step("machine");
    if (!(await this.machineExists(id))) await this.machineInit(id);
    let running = await this.machineRunning(id);
    if (running && opts.recover && !(await this.engineReachable(id))) {
      // The VM process died but its state still says running: stop it cleanly, then start below.
      try {
        await this.machineStop(id);
      } catch {
        // an already-dead VM can fail to stop; machineStart reports the real failure if it is still broken
      }
      running = false;
    }
    if (!running) await this.machineStart(id);

    step("image");
    await this.ensureNetwork(id);
    for (const img of [POSTGRES_IMAGE, REDIS_IMAGE, image]) await this.pullIfMissing(id, img);

    const password = await this.password(paths);

    step("postgres");
    await this.ensureContainer(id, names.postgres, postgresRunArgs(id, password, paths.postgres));
    await this.waitFor(
      "postgres",
      async () => (await this.raw(id, ["--connection", machineName(id), "exec", names.postgres, "psql", "-h", "127.0.0.1", "-U", "postgres", "-c", "select 1"])).code === 0,
      90_000,
    );
    // Password is only applied on first init; re-apply so a lost password file self-corrects.
    await this.pm(id, ["exec", names.postgres, "psql", "-h", "127.0.0.1", "-U", "postgres", "-c", `ALTER USER postgres WITH PASSWORD '${password}';`]);
    const hasDb = await this.pm(id, ["exec", names.postgres, "psql", "-h", "127.0.0.1", "-U", "postgres", "-tAc", "SELECT 1 FROM pg_database WHERE datname='aw_workspace'"]);
    if (hasDb.stdout.trim() !== "1") {
      await this.pm(id, ["exec", names.postgres, "psql", "-h", "127.0.0.1", "-U", "postgres", "-c", "CREATE DATABASE aw_workspace;"]);
    }
    await this.pm(id, ["exec", names.postgres, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "aw_workspace", "-c", "CREATE EXTENSION IF NOT EXISTS vector;"]);

    step("redis");
    await this.ensureContainer(id, names.redis, redisRunArgs(id, paths.redis));

    step("workspace");
    await this.seedWorkspaceDir(id, image, paths);
    const socketPath = await this.vmSocketPath(id);
    const input: WorkspaceRunInput = {
      ws,
      paths,
      password,
      socketPath,
      image,
      workers: this.cfg.workers ?? 2,
      authPublicKey: opts.authPublicKey,
    };
    const url = `http://127.0.0.1:${ws.apiPort}/api/health`;
    const wasRunning = opts.recover ? await this.containerRunning(id, names.workspace) : false;
    await this.ensureWorkspaceContainer(id, input);
    // A core that was already running but does not answer is hung: waiting on it would time out untouched.
    if (wasRunning && (await this.status(url)) !== 200) await this.pm(id, ["restart", names.workspace]);

    step("health");
    await this.waitFor("workspace health", async () => (await this.status(url)) === 200, opts.healthTimeoutMs ?? 180_000);
    step("running");
  }

  /** Recreate when the published API port changed (publish is fixed at creation; data is on bind mounts). */
  private async ensureWorkspaceContainer(id: string, input: WorkspaceRunInput): Promise<void> {
    const name = containerNames(id).workspace;
    if (await this.exists(id, ["container", "exists", name])) {
      const ports = await this.pm(id, ["inspect", name, "--format", "{{json .HostConfig.PortBindings}}"]);
      if (!ports.stdout.includes(`"HostPort":"${input.ws.apiPort}"`)) {
        await this.pm(id, ["rm", "-f", name]);
        await this.pm(id, workspaceRunArgs(input));
        return;
      }
    }
    await this.ensureContainer(id, name, workspaceRunArgs(input));
  }

  /** Stop the three containers (best effort is NOT used: failures throw) then the machine. */
  async stop(id: string): Promise<void> {
    const n = containerNames(id);
    if (await this.machineRunning(id)) {
      for (const c of [n.workspace, n.redis, n.postgres]) {
        if (await this.exists(id, ["container", "exists", c])) await this.pm(id, ["stop", c]);
      }
      await this.machineStop(id);
    }
  }

  /**
   * Full cleanup of ONE workspace: containers, network, the podman machine, then every
   * directory this workspace id owns (data, podman HOME, TMPDIR). Touches nothing else:
   * the id is validated and each path must resolve under its configured root, so the
   * default podman machine, the user's HOME and the live :9030 workspace are out of reach.
   * A machine-remove failure throws BEFORE any directory is deleted, so a retry still
   * has everything it needs; a workspace that never got a machine (half-created) is fine.
   */
  async destroy(id: string): Promise<void> {
    const paths = this.ownedDirs(id);
    if (await this.machineKnownToExist(id)) {
      if (await this.machineRunning(id)) {
        const n = containerNames(id);
        for (const c of [n.workspace, n.redis, n.postgres]) {
          try {
            await this.raw(id, ["--connection", machineName(id), "rm", "-f", c]);
          } catch {
            // the machine removal below takes the containers with it
          }
        }
        try {
          await this.raw(id, ["--connection", machineName(id), "network", "rm", "-f", networkName(id)]);
        } catch {
          // same: removed with the machine
        }
      }
      await this.machineRemove(id);
      if (await this.machineExists(id)) throw new Error(`could not remove machine ${machineName(id)}`);
    }
    for (const d of paths) this.fs.rmrf(d);
  }

  /**
   * Whether `id` may own a machine. Normally asks podman; when podman cannot answer (binary
   * missing, bootstrap died before it was usable) the answer comes from disk instead: a machine
   * lives entirely under this workspace's own podman HOME, so no machine artifacts there means
   * no VM was ever created. Artifacts present + podman unreachable is uncertain, so the error
   * is rethrown and data/registry are preserved for a retry.
   */
  private async machineKnownToExist(id: string): Promise<boolean> {
    try {
      return await this.machineExists(id);
    } catch (err) {
      const home = workspacePaths(this.cfg, id).home;
      const artifacts = [join(home, ".local", "share", "containers", "podman", "machine"), join(home, ".config", "containers", "podman", "machine")];
      let present: boolean;
      try {
        present = artifacts.some((d) => !this.fs.isEmptyDir(d));
      } catch {
        present = true; // unreadable artifact path: VM presence is uncertain
      }
      if (present) throw err;
      return false;
    }
  }

  /** The directories owned by `id`, each verified to sit strictly inside its configured root. */
  private ownedDirs(id: string): string[] {
    if (!/^[a-z0-9]+$/.test(id)) throw new Error(`refusing to clean up invalid workspace id "${id}"`);
    const p = workspacePaths(this.cfg, id);
    const dirs: Array<[string, string]> = [
      [p.data, this.cfg.dataRoot],
      [join(this.cfg.homesRoot, id), this.cfg.homesRoot],
      [p.tmp, this.cfg.tmpRoot ?? "/tmp"],
    ];
    for (const [dir, root] of dirs) {
      const rel = relative(root, dir);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing to remove ${dir}: outside ${root}`);
    }
    return dirs.map(([d]) => d);
  }
}
