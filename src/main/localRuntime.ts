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
import { darwinPlatform, type EnginePlatform } from "./enginePlatform";
import { get as httpGet } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { LocalWorkspace } from "./localRegistry";

/** Pinned public tag (v0.165.0: ui_changed push + app_revs, required for live menu updates). Not `latest`: the bundled UI must match the core. */
export const WORKSPACE_IMAGE = "ghcr.io/fredericowu/aw-workspace:v0.165.0";
/** Image every workspace created before per-workspace pinning was seeded from. */
export const LEGACY_WORKSPACE_IMAGE = "ghcr.io/fredericowu/aw-workspace:v0.158.0";
// Same pinned digests as aw-remote-host bootstrap/{postgres,redis}/install.sh.
export const POSTGRES_IMAGE =
  "docker.io/pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb";
export const REDIS_IMAGE =
  "docker.io/library/redis@sha256:a8f08480e1f88f2647fed492d1178c06abb0d0c1fbf02c682a61e2f483fb3954";

/** Top-level entries of the core image that an upgrade never overwrites: runtime state (installed apps, secrets,
 * venv under .aw-workspace), the user's own checkouts, and CLI credentials. Mirrors aw-remote-host's
 * syncWorkspaceSource, plus the user-owned directories a local workspace can also hold. */
export const UPGRADE_PRESERVED = new Set([
  ".aw-workspace", "apps", "repos", ".tmp", ".worktrees",
  ".claude", ".claude.json", ".codex", ".copilot", ".cursor",
  ".ssh", ".git-credentials", ".gitconfig",
]);

/** The image a workspace is pinned to (absent pin = created before per-workspace pinning). */
export const pinnedImage = (ws: Pick<LocalWorkspace, "image">): string => ws.image ?? LEGACY_WORKSPACE_IMAGE;

/** True when the workspace runs a different core image than the bundled one. */
export const upgradeAvailable = (ws: Pick<LocalWorkspace, "image">): boolean => pinnedImage(ws) !== WORKSPACE_IMAGE;

type UpgradePhase = "staged" | "stopped" | "dumped" | "swapping" | "core_starting" | "committed" | "rolled_back";
const PHASE_ORDER: UpgradePhase[] = ["staged", "stopped", "dumped", "swapping", "core_starting", "committed", "rolled_back"];

/** Persisted before the first destructive step, so a crash at any point can be undone (or finished) on the next start. */
interface UpgradeJournal {
  v: 1;
  from: string;
  to: string;
  phase: UpgradePhase;
  /** Scratch dir holding the staged tree and the backed-up entries; a sibling of the workspace dir. */
  root: string;
  dump: string;
  replace: string[];
  add: string[];
}

export class UpgradeFailedError extends Error {
  constructor(
    public readonly cause: unknown,
    /** True when the previous core is running again (or was never touched). False: needs attention, a retry resumes the rollback. */
    public readonly rolledBack: boolean,
  ) {
    super(`upgrade failed (${rolledBack ? "rolled back" : "NOT rolled back"}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "UpgradeFailedError";
  }
}

export interface UpgradeOptions {
  authPublicKey?: string;
  onStep?: (step: string) => void;
  healthTimeoutMs?: number;
  /** Image to move to. Defaults to the bundled WORKSPACE_IMAGE. */
  targetImage?: string;
  /** Called once the new core is healthy, BEFORE the old container is discarded: persist the new pin here. */
  onCommit?: (image: string) => void;
}

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

type ExecFileFn = typeof execFile;
const killTreeWin = (pid: number) => {
  // execFile's own timeout kills podman.exe only; wsl.exe and the proxy helpers would survive it.
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => undefined);
};

/** Runner for one platform. Darwin: plain execFile, timeout only when the caller gave one (unchanged).
 * Windows: a default timeout, and on expiry the whole process tree is killed. */
export function makeExecRunner(
  platform: EnginePlatform = darwinPlatform,
  exec: ExecFileFn = execFile,
  killTree: (pid: number) => void = killTreeWin,
): Runner {
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      const timeoutMs = opts.timeoutMs ?? platform.defaultTimeoutMs;
      const own = platform.treeKill && timeoutMs > 0; // we own the timer so we can kill the tree
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (r: RunResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      const child = exec(
        cmd,
        args,
        { env: opts.env, timeout: own ? 0 : timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          settle({ code, stdout: String(stdout), stderr: err && !stderr ? String(err.message) : String(stderr) });
        },
      );
      if (own) {
        timer = setTimeout(() => {
          // Settle AT the deadline: a helper holding the output pipe open can delay (or fake a success
          // for) execFile's own callback, so the result must not wait for it. Cleanup runs independently.
          settle({ code: 1, stdout: "", stderr: `timed out after ${Math.round(timeoutMs / 1000)}s` });
          if (child.pid !== undefined) killTree(child.pid);
          child.kill();
        }, timeoutMs);
      }
    });
}

export const execRunner: Runner = makeExecRunner();

export interface FsOps {
  mkdirp(p: string): void;
  writeFile(p: string, data: string, mode?: number): void;
  readFile(p: string): string | null;
  isEmptyDir(p: string): boolean;
  /** Recursive, forced delete; a missing path is not an error. */
  rmrf(p: string): void;
  /** Atomic move on one filesystem. Throws when `from` is missing. */
  rename(from: string, to: string): void;
  /** Entry names of a directory; [] when it does not exist. */
  listDir(p: string): string[];
  exists(p: string): boolean;
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
  rename: (from, to) => renameSync(from, to),
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw err;
    }
  },
  exists: (p) => existsSync(p),
};

export interface RuntimeConfig {
  /** Absolute path of the podman binary (vendored or system). */
  podmanPath: string;
  /** App data dir: per-workspace podman HOMEs live under <homesRoot>/<id>/home. */
  homesRoot: string;
  /** Workspace data root, e.g. ~/aw-workspaces. Must be under the real $HOME or shared into the VM. */
  dataRoot: string;
  /** Short dir for TMPDIR (default: the platform's, /tmp on macOS). Per workspace: <tmpRoot>/aw-<id>. */
  tmpRoot?: string;
  /** PATH handed to podman (gvproxy/vfkit/krunkit live next to it). */
  path: string;
  /** Platform seam; absent means macOS, the pre-seam behaviour. */
  platform?: EnginePlatform;
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
    tmp: join(cfg.tmpRoot ?? (cfg.platform ?? darwinPlatform).tmpRoot(cfg.homesRoot), `aw-${id}`),
    data,
    workspace: join(data, "workspace"),
    homeData: join(data, "home"),
    postgres: join(data, "postgres"),
    redis: join(data, "redis"),
    passwordFile: join(data, "postgres-password"),
  };
}

export function machineProvider(arch: string = process.arch): string {
  return darwinPlatform.provider(arch);
}

/** The ONLY env podman ever sees: own HOME, short TMPDIR, provider, and the bundled helper dir.
 * Nothing inherited (no CONTAINER_HOST etc.). CONTAINERS_HELPER_BINARY_DIR makes podman take
 * gvproxy/vfkit/krunkit from the signed engine next to it; without it podman searches its default
 * helper dirs first (Homebrew's), so a Mac with brew podman would boot the VM with unbundled helpers. */
export function podmanEnv(cfg: RuntimeConfig, id: string): Record<string, string> {
  const p = workspacePaths(cfg, id);
  const plat = cfg.platform ?? darwinPlatform;
  return plat.env({
    home: p.home,
    tmp: p.tmp,
    path: cfg.path,
    provider: plat.provider(cfg.arch ?? process.arch),
    helperDir: dirname(cfg.podmanPath),
  });
}

export function containersConf(cfg: RuntimeConfig): string {
  return `[machine]\nprovider = "${(cfg.platform ?? darwinPlatform).provider(cfg.arch ?? process.arch)}"\n`;
}

// ---- pure argument builders (no connection prefix; LocalRuntime adds it) ----

export function machineInitArgs(cfg: RuntimeConfig, id: string): string[] {
  const m = cfg.machine ?? {};
  const p = workspacePaths(cfg, id);
  return [
    "machine", "init", machineName(id),
    ...(cfg.platform ?? darwinPlatform).machineInitFlags(p.data, m),
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
    this.run = deps.run ?? (cfg.platform ? makeExecRunner(cfg.platform) : execRunner);
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

  /** Network, images, postgres (password + database + extension) and redis: everything the core needs besides itself.
   * Idempotent; shared by a normal start and an upgrade. Returns the postgres password. */
  private async ensureBackends(id: string, paths: WorkspacePaths, images: string[], step: (s: string) => void): Promise<string> {
    const names = containerNames(id);
    step("image");
    await this.ensureNetwork(id);
    for (const img of images) await this.pullIfMissing(id, img);

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
    return password;
  }

  /** Bring everything up in order: machine, network, postgres, redis, core, health. Surfaces every failure. */
  async start(ws: LocalWorkspace, opts: StartOptions = {}): Promise<void> {
    const id = ws.id;
    const step = opts.onStep ?? (() => undefined);
    const image = this.cfg.image ?? ws.image ?? LEGACY_WORKSPACE_IMAGE;
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

    const password = await this.ensureBackends(id, paths, [POSTGRES_IMAGE, REDIS_IMAGE, image], step);
    // An upgrade that was interrupted (app quit, crash, power loss) is rolled back before anything else touches the core.
    await this.recoverUpgrade(ws, paths, password);

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

  // ---- in-place core upgrade ----
  private journalPath(paths: WorkspacePaths): string {
    return join(paths.data, "upgrade.json");
  }
  /** No journal = no upgrade in flight. A journal that exists but cannot be read is NOT "none": guessing could pair the old
   * core with the new source, so it is surfaced and the workspace stays in needs-attention until it is resolved by hand. */
  private readJournal(paths: WorkspacePaths): UpgradeJournal | null {
    const raw = this.fs.readFile(this.journalPath(paths));
    if (raw === null) return null;
    try {
      const j = JSON.parse(raw) as UpgradeJournal;
      if (j && j.v === 1 && PHASE_ORDER.includes(j.phase)) return j;
    } catch {
      // fall through
    }
    throw new Error(`upgrade journal ${this.journalPath(paths)} is unreadable; refusing to guess the workspace state`);
  }
  /** Write-then-rename: a crash leaves either the previous journal or the new one, never a truncated file. */
  private writeJournal(paths: WorkspacePaths, j: UpgradeJournal): void {
    const file = this.journalPath(paths);
    this.fs.writeFile(`${file}.tmp`, JSON.stringify(j));
    this.fs.rename(`${file}.tmp`, file);
  }
  private async pgExec(id: string, args: string[], timeoutMs?: number): Promise<RunResult> {
    return this.pm(id, ["exec", containerNames(id).postgres, ...args], timeoutMs);
  }

  /**
   * Move ONE existing workspace to another core image in place. The core's source tree is a bind mount seeded from
   * the image at creation, so the image pin alone changes nothing: this also swaps the image-owned entries of that
   * tree (never UPGRADE_PRESERVED: installed apps, secrets, user checkouts) and keeps the database, redis and the
   * data dir untouched. Order: pull, stage the new tree, stop the core, dump the DB, swap the tree by rename (old
   * entries kept), recreate the core (old container kept, renamed), wait healthy, commit. Any failure after the
   * core is stopped runs the exact reverse; a crash leaves a journal that start() finishes. Never uses
   * bootstrap-workspace --force or unlink, and never removes the VM, postgres or redis.
   */
  async upgrade(ws: LocalWorkspace, opts: UpgradeOptions = {}): Promise<{ upgraded: boolean }> {
    const id = ws.id;
    const step = opts.onStep ?? (() => undefined);
    const target = opts.targetImage ?? WORKSPACE_IMAGE;
    const from = pinnedImage(ws);
    const paths = this.prepare(id);
    const names = containerNames(id);
    const prev = `${names.workspace}-prev`;
    let journal: UpgradeJournal | null = null;
    let scratch: string | null = null;
    let pinned = false;
    let password = "";
    try {
      step("machine");
      if (!(await this.machineExists(id))) throw new Error(`no machine for workspace ${id}`);
      if (!(await this.machineRunning(id))) await this.machineStart(id);
      password = await this.ensureBackends(id, paths, [POSTGRES_IMAGE, REDIS_IMAGE, target], step);
      // A leftover from an interrupted attempt is resolved first (rolled back, or its cleanup finished).
      await this.recoverUpgrade(ws, paths, password);
      if (from === target) return { upgraded: false };

      // 1. Stage the new tree beside the workspace dir, while the old core is still serving.
      const stamp = String(this.clock());
      const root = join(paths.data, `upgrade-${stamp}`);
      scratch = root;
      const stage = join(root, "stage");
      const backup = join(root, "backup");
      this.fs.mkdirp(stage);
      this.fs.mkdirp(backup);
      const seed = `aw-${id}-upgrade-seed`;
      await this.raw(id, ["--connection", machineName(id), "rm", "-f", seed]); // stale seed from a killed attempt: ignore the result
      await this.pm(id, ["create", "--pull=never", "--name", seed, target]);
      try {
        await this.pm(id, ["cp", `${seed}:${CONTAINER_WORKDIR}/.`, stage], 1_800_000);
      } finally {
        await this.raw(id, ["--connection", machineName(id), "rm", "-f", seed]);
      }
      const shipped = this.fs.listDir(stage).filter((n) => !UPGRADE_PRESERVED.has(n));
      if (shipped.length === 0) throw new Error("the new core image shipped no source tree");
      const replace = shipped.filter((n) => this.fs.exists(join(paths.workspace, n)));
      const add = shipped.filter((n) => !replace.includes(n));
      journal = { v: 1, from, to: target, phase: "staged", root, dump: `aw-upgrade-${stamp}.dump`, replace, add };
      this.writeJournal(paths, journal);

      // 2. Stop the old core (kept, not removed) and take a consistent DB dump: the new core migrates it forward.
      step("workspace");
      if (await this.exists(id, ["container", "exists", names.workspace])) {
        await this.raw(id, ["--connection", machineName(id), "rm", "-f", prev]);
        await this.pm(id, ["stop", names.workspace], 120_000);
      }
      journal = this.advanceJournal(paths, journal, "stopped");
      await this.pgExec(id, ["pg_dump", "-h", "127.0.0.1", "-U", "postgres", "-Fc", "-f", `/var/lib/postgresql/data/${journal.dump}`, "aw_workspace"], 1_800_000);
      journal = this.advanceJournal(paths, journal, "dumped");

      // 3. Swap the image-owned entries by rename (same filesystem): old ones are parked in backup/, never copied or deleted.
      journal = this.advanceJournal(paths, journal, "swapping");
      for (const n of replace) this.fs.rename(join(paths.workspace, n), join(backup, n));
      for (const n of shipped) this.fs.rename(join(stage, n), join(paths.workspace, n));

      // 4. Recreate the core on the new image; the old container stays, renamed, for rollback.
      if (await this.exists(id, ["container", "exists", names.workspace])) await this.pm(id, ["rename", names.workspace, prev]);
      const socketPath = await this.vmSocketPath(id);
      const input: WorkspaceRunInput = { ws, paths, password, socketPath, image: target, workers: this.cfg.workers ?? 2, authPublicKey: opts.authPublicKey };
      journal = this.advanceJournal(paths, journal, "core_starting");
      await this.pm(id, workspaceRunArgs(input));
      step("health");
      // strict=1: a core that answers 200 but reports a component down ("degraded") must not pass the commit gate.
      const url = `http://127.0.0.1:${ws.apiPort}/api/health?strict=1`;
      await this.waitFor("workspace health", async () => (await this.status(url)) === 200, opts.healthTimeoutMs ?? 300_000);

      // 5. Commit: persist the new pin first. From here the upgrade is DONE: nothing below may roll it back
      // (recovery resolves the boundary by the persisted pin), only best-effort bookkeeping remains.
      opts.onCommit?.(target);
      pinned = true;
      try {
        journal = this.advanceJournal(paths, journal, "committed");
        step("running");
        await this.finishUpgradeCleanup(id, paths, journal);
      } catch {
        // journal/cleanup leftovers are resolved forward by the next start (pin === journal.to)
      }
      return { upgraded: true };
    } catch (err) {
      if (!journal) {
        // Nothing destructive ran (pull/stage failed): the old core was never stopped. Drop the scratch dir, if any.
        if (scratch) this.fs.rmrf(scratch);
        throw new UpgradeFailedError(err, true);
      }
      if (pinned) return { upgraded: true };
      let rolledBack = false;
      try {
        await this.rollbackUpgrade(ws, paths, password, journal);
        rolledBack = true;
      } catch {
        // journal stays on disk: the next start() retries the rollback
      }
      throw new UpgradeFailedError(err, rolledBack);
    }
  }

  private advanceJournal(paths: WorkspacePaths, j: UpgradeJournal, phase: UpgradePhase): UpgradeJournal {
    const next = { ...j, phase };
    this.writeJournal(paths, next);
    return next;
  }

  /** Called at start/upgrade entry: finish or undo an upgrade that never reached its end. No-op without a journal. */
  async recoverUpgrade(ws: LocalWorkspace, paths: WorkspacePaths, password: string): Promise<void> {
    const j = this.readJournal(paths);
    if (!j) return;
    // The persisted pin is the commit point (it is saved before the journal says "committed"): a pin equal to the
    // target means the new core was verified healthy, so resolve FORWARD even if the journal write never landed.
    // "rolled_back" means the restore finished and only cleanup was interrupted: never replay the restore.
    if (j.phase === "committed" || j.phase === "rolled_back" || pinnedImage(ws) === j.to) {
      await this.finishUpgradeCleanup(ws.id, paths, j);
      return;
    }
    await this.rollbackUpgrade(ws, paths, password, j);
  }

  /** The exact reverse of upgrade(); idempotent, so it can resume a rollback that itself was interrupted. */
  private async rollbackUpgrade(ws: LocalWorkspace, paths: WorkspacePaths, password: string, j: UpgradeJournal): Promise<void> {
    const id = ws.id;
    const names = containerNames(id);
    const prev = `${names.workspace}-prev`;
    const reached = (p: UpgradePhase) => PHASE_ORDER.indexOf(j.phase) >= PHASE_ORDER.indexOf(p);
    const backup = join(j.root, "backup");

    // a. The new core (if it was ever created) goes first: it holds the DB and the ports.
    if (reached("core_starting")) await this.raw(id, ["--connection", machineName(id), "rm", "-f", names.workspace]);
    // b. A core that ran against the DB may have migrated it forward: put the pre-upgrade dump back.
    if (reached("core_starting")) {
      const file = `/var/lib/postgresql/data/${j.dump}`;
      const psql = ["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-c"];
      await this.pgExec(id, [...psql, "DROP DATABASE IF EXISTS aw_workspace WITH (FORCE)"]);
      await this.pgExec(id, [...psql, "CREATE DATABASE aw_workspace"]);
      await this.pgExec(id, ["pg_restore", "-h", "127.0.0.1", "-U", "postgres", "-d", "aw_workspace", file], 1_800_000);
    }
    // c. Source tree: put parked entries back, drop entries that did not exist before.
    if (reached("swapping")) {
      for (const n of j.replace) {
        if (this.fs.exists(join(backup, n))) {
          this.fs.rmrf(join(paths.workspace, n));
          this.fs.rename(join(backup, n), join(paths.workspace, n));
        }
      }
      for (const n of j.add) this.fs.rmrf(join(paths.workspace, n));
    }
    // d. The old core container back under its own name, running, on its own image.
    const hasMain = await this.exists(id, ["container", "exists", names.workspace]);
    if (!hasMain && (await this.exists(id, ["container", "exists", prev]))) await this.pm(id, ["rename", prev, names.workspace]);
    const socketPath = await this.vmSocketPath(id);
    const input: WorkspaceRunInput = { ws, paths, password, socketPath, image: j.from, workers: this.cfg.workers ?? 2 };
    // Port-aware: recreates the old core when its published port is no longer the workspace's (reconciled) port.
    await this.ensureWorkspaceContainer(id, input);
    const url = `http://127.0.0.1:${ws.apiPort}/api/health`;
    await this.waitFor("restored workspace health", async () => (await this.status(url)) === 200, 180_000);
    // Terminal marker BEFORE the dump is deleted: a crash during cleanup must never replay the DB restore without it.
    this.writeJournal(paths, { ...j, phase: "rolled_back" });
    await this.finishUpgradeCleanup(id, paths, j);
  }

  /** Discard what an upgrade leaves behind. Best effort: garbage left here costs disk, never correctness. */
  private async finishUpgradeCleanup(id: string, paths: WorkspacePaths, j: UpgradeJournal): Promise<void> {
    const names = containerNames(id);
    for (const task of [
      () => this.raw(id, ["--connection", machineName(id), "rm", "-f", `${names.workspace}-prev`]),
      () => this.raw(id, ["--connection", machineName(id), "rm", "-f", `aw-${id}-upgrade-seed`]),
      () => this.pgExec(id, ["rm", "-f", `/var/lib/postgresql/data/${j.dump}`]),
      async () => this.fs.rmrf(j.root),
    ]) {
      try {
        await task();
      } catch {
        // see above
      }
    }
    this.fs.rmrf(this.journalPath(paths));
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
      [p.tmp, this.cfg.tmpRoot ?? (this.cfg.platform ?? darwinPlatform).tmpRoot(this.cfg.homesRoot)],
    ];
    for (const [dir, root] of dirs) {
      const rel = relative(root, dir);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing to remove ${dir}: outside ${root}`);
    }
    return dirs.map(([d]) => d);
  }
}
