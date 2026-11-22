// Main-process service for standalone local workspaces (card 41f5bf3b, design v2).
// Wires LocalRegistry + LocalRuntime + FrontServer together. No aw-remote-host.
import { app } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_BASE } from "./config";
import { createFrontServer, type FrontServer } from "./frontServer";
import { fileStore, LocalRegistry, registryPath, type LocalWorkspace } from "./localRegistry";
import { LocalRuntime, type RuntimeConfig } from "./localRuntime";
import type { BootstrapStepId, WorkspaceInfo } from "../shared/types";
import { LOCAL_PLACEMENT } from "../shared/workspaces";

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
export function toWorkspaceInfo(ws: LocalWorkspace, running: boolean): WorkspaceInfo {
  return {
    name: ws.id,
    display_name: ws.name,
    placement_driver: LOCAL_PLACEMENT,
    is_hosted: false,
    status: running ? "running" : "stopped",
  };
}

/** Where the bundled container engine lives: packaged resources, or AW_DESKTOP_ENGINE_DIR for dev
 * (a directory holding bin/, lib/, share/ as laid out by scripts/fetch-engine.sh). The app never
 * reads or writes ~/podman-dist: that directory belongs to aw-remote-host's own bootstrap. */
export function engineDir(): string {
  return process.env["AW_DESKTOP_ENGINE_DIR"] || join(process.resourcesPath ?? "", "engine");
}

export const podmanBinPath = (engine = engineDir()) => join(engine, "bin", "podman");

/** macOS caps a unix socket path at 103 bytes. podman creates
 * <home>/.podman/aw-<id>-ignition.sock, so the per-workspace HOME must be short:
 * under ~/Library/Application Support/aw-desktop it was 117 bytes and
 * `podman machine start` died with "bind: invalid argument". */
export function runtimeConfig(_userData: string, home = homedir(), engine = engineDir()): RuntimeConfig {
  const bin = dirname(podmanBinPath(engine));
  return {
    podmanPath: podmanBinPath(engine),
    homesRoot: join(home, ".awd"),
    dataRoot: join(home, "aw-workspaces"),
    path: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    arch: process.arch,
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

  constructor(getToken: () => string | null, fetchMaxLocal: (token: string) => Promise<number | undefined>) {
    const userData = app.getPath("userData");
    this.registry = new LocalRegistry({
      store: fileStore(registryPath(userData)),
      fetchMaxLocal: async () => {
        const t = getToken();
        return t ? fetchMaxLocal(t) : undefined;
      },
    });
    this.runtime = new LocalRuntime(runtimeConfig(userData));
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  rowsFor(sub: string): WorkspaceInfo[] {
    return this.registry.listFor(sub).map((w) => toWorkspaceInfo(w, this.running.has(w.id)));
  }

  /** Bring the machine, containers and front server up. Returns the (possibly port-bumped) record. */
  async start(id: string, authPublicKey: string, onStep: (s: BootstrapStepId) => void): Promise<LocalWorkspace> {
    const { workspace } = await this.registry.reconcilePorts(id, (p) => {
      // Our own front server (UI port) or running container (API port) is not a conflict.
      const cur = this.registry.get(id);
      if (!cur) return false;
      const front = this.fronts.get(id);
      if (p === cur.uiPort) return !!front && front.server.listening;
      return p === cur.apiPort && this.running.has(id);
    });
    await this.runtime.start(workspace, { authPublicKey, onStep: (s) => onStep(stepFor(s)) });
    await this.fronts.get(id)?.close();
    const front = createFrontServer({ uiPort: workspace.uiPort, apiPort: workspace.apiPort, staticDir: uiStaticDir() });
    await front.listen();
    this.fronts.set(id, front);
    this.running.add(id);
    return workspace;
  }

  /** Remove one workspace completely: front server, containers, machine, dirs, then the registry entry.
   * The registry entry goes LAST so a failed cleanup stays visible and can be retried; ports free with it. */
  async destroy(id: string): Promise<void> {
    if (!this.registry.get(id)) return;
    await this.fronts.get(id)?.close();
    this.fronts.delete(id);
    this.running.delete(id);
    await this.runtime.destroy(id);
    this.registry.remove(id);
  }

  /** Stop every running workspace (app quit). Best effort per workspace so one failure does not strand the rest. */
  async stopAll(): Promise<void> {
    const ids = [...this.running];
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
