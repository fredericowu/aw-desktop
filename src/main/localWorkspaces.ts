// Main-process service for standalone local workspaces (card 41f5bf3b, design v2).
// Wires LocalRegistry + LocalRuntime + FrontServer together. No aw-remote-host.
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_BASE } from "./config";
import { createFrontServer, type DesktopBridge, type FrontServer } from "./frontServer";
import { fileStore, LocalRegistry, probeLoopbackPortBothFamilies, registryPath, type LocalWorkspace } from "./localRegistry";
import { ensureWslConfig } from "./wslConfig";
import { LocalRuntime, PortConflictError, upgradeAvailable, type RuntimeConfig, type StartOptions } from "./localRuntime";
import { platformFor, type EnginePlatform } from "./enginePlatform";
import type { BootstrapStepId, WorkspaceInfo } from "../shared/types";
import { LOCAL_PLACEMENT } from "../shared/workspaces";
import { SUPERVISOR_COPY } from "../shared/errorCopy";
import { Supervisor, type RecoverOutcome, type SupervisedStatus } from "./supervisorCore";

export const SUPERVISOR_POLL_MS = 15_000;

export interface SupervisorHooks {
  /** Runs `work` inside the app's single setup slot; resolves "busy" without running it when the slot is taken. */
  exclusive(work: () => Promise<void>): Promise<RecoverOutcome>;
  onStatus(id: string): void;
  onFailure(id: string, err: unknown): void;
  /** Key for a recovery start (identity public key). */
  authKey(): Promise<string>;
}

/** Maps LocalRuntime.start() step names to the progress model's steps. */
export function stepFor(runtimeStep: string): BootstrapStepId {
  switch (runtimeStep) {
    case "machine": return "machine";
    case "image": return "image";
    case "postgres": return "postgres";
    case "redis": return "redis";
    case "workspace": return "workspace";
    default: return "running"; // "health" and "running"
  }
}

/** The renderer-facing row for a registry record (`name` is the registry id, the slug `pickWorkspace` takes). */
export function toWorkspaceInfo(ws: LocalWorkspace, running: boolean, supervised: SupervisedStatus | null = null, platform: EnginePlatform = platformFor()): WorkspaceInfo {
  const base = {
    name: ws.id,
    display_name: ws.name,
    placement_driver: LOCAL_PLACEMENT,
    is_hosted: false,
    // Windows v1 defers the in-place upgrade (PO decision 1): never offer an action that cannot run.
    ...(platform.supportsUpgrade && upgradeAvailable(ws) ? { upgrade_available: true } : {}),
  };
  if (running && supervised === "starting") return { ...base, status: "starting", detail: SUPERVISOR_COPY.starting };
  if (running && supervised === "needs_attention") return { ...base, status: "needs_attention", detail: SUPERVISOR_COPY.needs_attention };
  return { ...base, status: running ? "running" : "stopped" };
}

/** Where the bundled container engine lives: packaged resources, or AW_DESKTOP_ENGINE_DIR for dev
 * (a directory holding bin/, lib/, share/ as laid out by scripts/fetch-engine.sh). The app never
 * reads or writes ~/podman-dist: that directory belongs to aw-remote-host's own bootstrap. */
export function engineDir(): string {
  return process.env["AW_DESKTOP_ENGINE_DIR"] || join(process.resourcesPath ?? "", "engine");
}

export const podmanBinPath = (engine = engineDir(), platform: EnginePlatform = platformFor()) =>
  join(engine, "bin", platform.exeName("podman"));

/** macOS caps a unix socket path at 103 bytes. podman creates
 * <home>/.podman/aw-<id>-ignition.sock, so the per-workspace HOME must be short:
 * under ~/Library/Application Support/aw-desktop it was 117 bytes and
 * `podman machine start` died with "bind: invalid argument". */
export function runtimeConfig(_userData: string, home = homedir(), engine = engineDir(), platform: EnginePlatform = platformFor()): RuntimeConfig {
  const bin = dirname(podmanBinPath(engine, platform));
  return {
    podmanPath: podmanBinPath(engine, platform),
    homesRoot: join(home, ".awd"),
    dataRoot: join(home, "aw-workspaces"),
    path: platform.path(bin),
    arch: process.arch,
    platform,
  };
}

/** Where the bundled workspace UI build lives: packaged resources, or AW_DESKTOP_UI_DIR for dev. */
export function uiStaticDir(): string {
  return process.env["AW_DESKTOP_UI_DIR"] || join(process.resourcesPath ?? "", "ui");
}

export class LocalWorkspaces {
  readonly registry: LocalRegistry;
  readonly runtime: LocalRuntime;
  private readonly fronts = new Map<string, FrontServer>();
  private readonly running = new Set<string>();
  private readonly supervisor: Supervisor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hooks: SupervisorHooks | null = null;
  private desktopBridge: ((id: string) => DesktopBridge) | null = null;
  private shuttingDown = false;
  private recovering: Promise<unknown> | null = null;
  /** Launch cleanup in flight. It does NOT hold the setup slot (that made the first Start fail with a false
   * "setup already running"); start/upgrade/destroy wait for it instead, so a click during it just queues. */
  private cleanup: Promise<void> | null = null;
  /** Workspaces an upgrade has touched this session: its VM may be up without the workspace being in `running`. */
  private readonly upgraded = new Set<string>();

  constructor(getToken: () => string | null, fetchMaxLocal: (token: string) => Promise<number | undefined>) {
    const userData = app.getPath("userData");
    this.registry = new LocalRegistry({
      store: fileStore(registryPath(userData)),
      ...(platformFor().id === "win32" ? { isPortFree: probeLoopbackPortBothFamilies } : {}),
      fetchMaxLocal: async () => {
        const t = getToken();
        return t ? fetchMaxLocal(t) : undefined;
      },
    });
    this.runtime = new LocalRuntime(runtimeConfig(userData));
    this.supervisor = new Supervisor({
      healthy: async (id) => {
        const ws = this.registry.get(id);
        if (!ws) return false;
        return (await this.runtime.healthStatus(ws.apiPort)) === 200;
      },
      recover: (id) => this.recover(id),
      onStatus: (id) => this.hooks?.onStatus(id),
      onFailure: (id, err) => this.hooks?.onFailure(id, err),
    });
  }

  /** Per-workspace /desktop/v1/* bridge for the Settings > About tab. Set once at app ready, before any front server starts. */
  setDesktopBridge(factory: (id: string) => DesktopBridge): void {
    this.desktopBridge = factory;
  }

  /** Begin polling health of every running workspace. Call once at app ready. */
  startSupervisor(hooks: SupervisorHooks, pollMs = SUPERVISOR_POLL_MS): void {
    this.hooks = hooks;
    this.timer ??= setInterval(() => void this.supervisor.tick(), pollMs);
  }

  /** Check now (wake from sleep): a VM that died while the Mac slept is noticed without waiting a full poll. */
  checkNow(): Promise<void> {
    return this.supervisor.tick();
  }

  private recover(id: string): Promise<RecoverOutcome> {
    const p = this.recoverNow(id);
    this.recovering = p;
    return p.finally(() => {
      if (this.recovering === p) this.recovering = null;
    });
  }

  private desktopOpt(id: string): { desktop?: DesktopBridge } {
    return this.desktopBridge ? { desktop: this.desktopBridge(id) } : {};
  }

  private async recoverNow(id: string): Promise<RecoverOutcome> {
    const hooks = this.hooks;
    const ws = this.registry.get(id);
    if (!hooks || !ws || this.shuttingDown) return "busy";
    return hooks.exclusive(async () => {
      // The user may have stopped or removed it, or the app started quitting, while we waited for the slot.
      const live = () => this.supervisor.watching(id) && !!this.registry.get(id) && !this.shuttingDown;
      if (!live()) return;
      const authPublicKey = await hooks.authKey();
      if (!live()) return;
      const moved = await this.startWithPortRetry(id, { authPublicKey, recover: true });
      // The saved port was taken meanwhile and the workspace moved: the front server still proxies to the old one.
      if (this.running.has(id) && (moved.apiPort !== ws.apiPort || moved.uiPort !== ws.uiPort)) {
        await this.fronts.get(id)?.close();
        const front = createFrontServer({ uiPort: moved.uiPort, apiPort: moved.apiPort, staticDir: uiStaticDir(), ...this.desktopOpt(id) });
        await front.listen();
        this.fronts.set(id, front);
      }
    });
  }

  /** User Retry from the in-window banner: a start (recovery mode after needs attention) that is part of the
   * shutdown lifecycle. Resolves false without touching the runtime once quit has begun. Caller holds the setup slot. */
  retry(id: string, authKey: () => Promise<string>): Promise<boolean> {
    if (this.shuttingDown) return Promise.resolve(false);
    const p = (async () => {
      const key = await authKey();
      if (this.shuttingDown || !this.registry.get(id)) return false;
      await this.start(id, key, () => undefined);
      return true;
    })();
    this.recovering = p;
    return p.finally(() => {
      if (this.recovering === p) this.recovering = null;
    });
  }

  /** Supervisor status of a watched workspace (null when unwatched). */
  supervisedStatus(id: string): SupervisedStatus | null {
    return this.supervisor.status(id);
  }

  /** Needs attention: still holds its ports, but the picker must offer Retry (a full start) instead of Open. */
  needsAttention(id: string): boolean {
    return this.supervisor.status(id) === "needs_attention";
  }

  /** User-initiated stop of one workspace. Unwatched FIRST so the supervisor can never restart it. */
  async stop(id: string): Promise<void> {
    this.supervisor.unwatch(id);
    await this.fronts.get(id)?.close();
    this.fronts.delete(id);
    try {
      await this.runtime.stop(id);
    } finally {
      this.running.delete(id);
    }
  }

  /** Launch cleanup: a force-quit leaves VMs running. Stop only machines of registry workspaces (own HOME each). */
  launchCleanup(onError: (id: string, err: unknown) => void = () => undefined): Promise<void> {
    const p = (async () => {
      for (const ws of this.registry.list()) {
        if (this.running.has(ws.id)) continue;
        try {
          await this.runtime.stop(ws.id);
        } catch (err) {
          onError(ws.id, err);
        }
      }
    })();
    this.cleanup = p;
    return p.finally(() => {
      if (this.cleanup === p) this.cleanup = null;
    });
  }

  /** Resolves once launch cleanup (if any) is done. Never rejects. */
  private async cleanupSettled(): Promise<void> {
    await this.cleanup?.catch(() => undefined);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  rowsFor(sub: string): WorkspaceInfo[] {
    return this.registry.listFor(sub).map((w) => toWorkspaceInfo(w, this.running.has(w.id), this.supervisor.status(w.id)));
  }

  private reconcile(id: string, avoid: ReadonlySet<number> = new Set()) {
    return this.registry.reconcilePorts(id, (p) => {
      // Our own front server (UI port) or running container (API port) is not a conflict.
      const cur = this.registry.get(id);
      if (!cur) return false;
      const front = this.fronts.get(id);
      if (p === cur.uiPort) return !!front && front.server.listening;
      return p === cur.apiPort && this.running.has(id);
    }, avoid);
  }

  /** reconcile + runtime.start, retrying on a port the engine reports busy (bounded). Shared by a normal start and
   * automatic recovery, so a port taken while the VM was down is replaced instead of retried forever. */
  private async startWithPortRetry(id: string, opts: StartOptions): Promise<LocalWorkspace> {
    const avoid = new Set<number>();
    for (let attempt = 0; ; attempt++) {
      const { workspace } = await this.reconcile(id, avoid);
      try {
        await this.runtime.start(workspace, opts);
        return workspace;
      } catch (err) {
        if (!(err instanceof PortConflictError) || attempt >= 4) throw err;
        avoid.add(err.port);
      }
    }
  }

  /** Bring the machine, containers and front server up. Returns the (possibly port-bumped) record. */
  async start(id: string, authPublicKey: string, onStep: (s: BootstrapStepId) => void): Promise<LocalWorkspace> {
    await this.cleanupSettled();
    // Retry after "needs attention": the core may still be running but hung, so use recovery rules.
    const recover = this.needsAttention(id);
    if (platformFor().id === "win32") {
      ensureWslConfig(homedir(), { read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null), write: (p, d) => writeFileSync(p, d) });
    }
    const workspace = await this.startWithPortRetry(id, { authPublicKey, recover, onStep: (s) => onStep(stepFor(s)) });
    await this.fronts.get(id)?.close();
    const front = createFrontServer({ uiPort: workspace.uiPort, apiPort: workspace.apiPort, staticDir: uiStaticDir(), ...this.desktopOpt(id) });
    await front.listen();
    this.fronts.set(id, front);
    this.running.add(id);
    this.supervisor.watch(id);
    return workspace;
  }

  /**
   * Explicit, user-requested in-place upgrade of ONE workspace to the bundled core image. Caller holds the setup slot.
   * The supervisor is unwatched for the duration (it must not "recover" a core we stopped on purpose) and is
   * re-attached on every exit. On success the workspace is running the new core with its front server up; on failure
   * the previous core is running again (see LocalRuntime.upgrade) and the registry pin is unchanged.
   */
  upgrade(id: string, authPublicKey: string, onStep: (s: BootstrapStepId) => void): Promise<void> {
    // Registered as the in-flight runtime operation so quit (stopAll) waits for it instead of stopping postgres/the VM under it.
    const p = this.cleanupSettled().then(() => this.upgradeNow(id, authPublicKey, onStep));
    this.recovering = p;
    return p.finally(() => {
      if (this.recovering === p) this.recovering = null;
    });
  }

  private async upgradeNow(id: string, authPublicKey: string, onStep: (s: BootstrapStepId) => void): Promise<void> {
    if (!this.registry.get(id)) throw new Error(`unknown local workspace ${id}`);
    if (this.shuttingDown) throw new Error("app is quitting");
    this.upgraded.add(id);
    const watched = this.supervisor.watching(id);
    this.supervisor.unwatch(id);
    try {
      // A stopped workspace's saved port may have been taken meanwhile: settle ports first, exactly as a normal start does.
      const { workspace } = await this.reconcile(id);
      await this.runtime.upgrade(workspace, {
        authPublicKey,
        onStep: (s) => onStep(stepFor(s)),
        onCommit: (image) => this.registry.setImage(id, image),
      });
    } catch (err) {
      if (watched && this.running.has(id)) this.supervisor.watch(id);
      throw err;
    }
    // The core on the new image is up and its port is ours: a normal start brings the front server back and re-watches.
    this.running.add(id);
    await this.start(id, authPublicKey, () => undefined);
  }

  /** Remove one workspace completely: front server, containers, machine, dirs, then the registry entry.
   * The registry entry goes LAST so a failed cleanup stays visible and can be retried; ports free with it. */
  async destroy(id: string): Promise<void> {
    await this.cleanupSettled();
    if (!this.registry.get(id)) return;
    await this.fronts.get(id)?.close();
    this.fronts.delete(id);
    this.running.delete(id);
    this.supervisor.unwatch(id);
    await this.runtime.destroy(id);
    this.registry.remove(id);
  }

  /** Stop every running workspace (app quit). Best effort per workspace so one failure does not strand the rest. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.supervisor.unwatchAll();
    // A recovery already past its checks may be mid `machine start`: wait for it so we stop what it started.
    await this.recovering?.catch(() => undefined);
    // An upgrade may have brought a VM up for a workspace that never entered `running`: stop those too.
    const ids = [...new Set([...this.running, ...this.upgraded])];
    for (const id of ids) {
      try {
        await this.fronts.get(id)?.close();
        this.fronts.delete(id);
        await this.runtime.stop(id);
      } catch {
        // machine may already be gone
      } finally {
        this.running.delete(id);
      }
    }
  }
}

// ---- identity public key (pinned into the container as AW_AUTH_PUBLIC_KEY) ----
const keyFile = () => join(app.getPath("userData"), "identity-public-key.pem");

export async function fetchIdentityPublicKey(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`${API_BASE}/api/identity/public-key`);
  if (!res.ok) throw new Error(`public key fetch failed (${res.status})`);
  const pem = (await res.text()).trim();
  if (!pem.includes("BEGIN PUBLIC KEY")) throw new Error("public key response was not a PEM");
  return pem;
}

/** Fresh key when reachable (cached), else the cached copy (offline start). */
export async function identityPublicKey(): Promise<string> {
  try {
    const pem = await fetchIdentityPublicKey();
    mkdirSync(dirname(keyFile()), { recursive: true });
    writeFileSync(keyFile(), pem);
    return pem;
  } catch (err) {
    if (existsSync(keyFile())) return readFileSync(keyFile(), "utf8");
    throw err;
  }
}

/** The cached key, or null. Recovery reads this first so a stalled identity endpoint cannot hold the setup slot. */
export function cachedIdentityPublicKey(): string | null {
  try {
    return existsSync(keyFile()) ? readFileSync(keyFile(), "utf8") : null;
  } catch {
    return null;
  }
}
