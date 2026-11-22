import { createHash } from "node:crypto";
import type { DepId, DepPlan, DepState, DepStatus, DepsSnapshot } from "../shared/deps";

/** Pinned vendored Podman, same version aw-remote-host's bootstrap/podman/install.sh uses.
 * sha256 is pinned HERE (not fetched next to the file it guards). Only an arm64 .pkg
 * exists for this release, so Intel Macs are reported as unsupported rather than guessed. */
export const PODMAN_VERSION = "6.0.2";
export const PODMAN_PKG_SHA256: Record<string, string> = {
  arm64: "5a1d97f98f626cdb82dbd9932cf43102d1e9b6621627085fec2dcadf59743930",
};
export const PODMAN_PKG_BYTES: Record<string, number> = { arm64: 74802386 };

export const podmanPkgUrl = (arch: string) =>
  `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-installer-macos-${arch}.pkg`;

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/** What a probe sees. Injectable so the screen logic runs off a Mac. */
export interface DepProbe {
  /** The vendored podman (the one bootstrap will use) exists and runs. */
  podman: boolean;
}

export interface Env {
  platform: string;
  arch: string;
}

export function plansFor(env: Env): Record<DepId, DepPlan | undefined> {
  const arm = env.platform === "darwin" && env.arch === "arm64";
  return {
    podman: arm
      ? {
          source: podmanPkgUrl("arm64"),
          size: mb(PODMAN_PKG_BYTES.arm64),
          checksum: `sha256 ${PODMAN_PKG_SHA256.arm64}`,
          dest: "inside the AW Desktop app (bundled; nothing is written to your home folder)",
          needsAdmin: false,
        }
      : undefined,
    machine: undefined,
  };
}

/** Pure: builds the screen from a probe + in-flight install state. */
export function buildSnapshot(
  env: Env,
  probe: DepProbe,
  live: Partial<Record<DepId, { state: DepState; progress?: number; error?: string; hint?: string }>>,
  interrupted?: DepId,
): DepsSnapshot {
  const supported = env.platform === "darwin" && env.arch === "arm64";
  const plans = plansFor(env);
  const installed: Record<DepId, boolean> = { podman: probe.podman, machine: false };
  const meta: Record<DepId, Pick<DepStatus, "title" | "sub" | "required" | "after" | "note">> = {
    podman: {
      title: "Podman (container runtime)",
      sub: "Setup always needs the podman command. Docker Desktop alone is not enough.",
      required: true,
    },
    machine: {
      title: "Podman machine",
      sub: "The small Linux VM Podman runs your workspace in",
      required: false,
      after: ["podman"],
      note: "Created per workspace during setup (one small VM each). Nothing to do here.",
    },
  };
  const items: DepStatus[] = (["podman", "machine"] as DepId[]).map((id) => {
    const l = live[id];
    let state: DepState = installed[id] ? "installed" : "missing";
    // An in-flight/failed install wins over the probe only until the probe sees it installed.
    if (!installed[id] && l) state = l.state;
    return {
      id,
      ...meta[id],
      state,
      progress: state === "installing" ? l?.progress ?? 0 : undefined,
      hint: state === "waiting" ? l?.hint : undefined,
      error: state === "failed" ? l?.error : undefined,
      plan: plans[id],
      after: id === "podman" ? undefined : meta[id].after,
    };
  });
  const ready = supported && items.filter((i) => i.required).every((i) => i.state === "installed");
  return { platform: env.platform, supported, items, ready, interrupted };
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Throws unless the bytes hash to `expected`. */
export function verifySha256(buf: Uint8Array, expected: string, what: string): void {
  const actual = sha256Hex(buf);
  if (actual !== expected.toLowerCase()) throw new Error(`checksum mismatch for ${what}: expected ${expected}, got ${actual}`);
}

/** Side effects of installing, injectable. */
export interface InstallOps {
  /** Download (reporting progress) -> bytes. */
  download(url: string, onProgress: (pct: number) => void): Promise<Uint8Array>;
  /** Unused at runtime: the engine is bundled in the app, so the real implementation only reports it missing. */
  unpackPodmanPkg(pkg: Uint8Array): Promise<void>;
}

export interface InstallerDeps {
  ops: InstallOps;
  env: Env;
  /** Persists {installing: id} across an app quit (null clears). */
  persist(marker: DepId | null): void;
  onChange(): void;
}

/** Single-flight installer holding the live state shown on the screen. */
export class DepInstaller {
  readonly live: Partial<Record<DepId, { state: DepState; progress?: number; error?: string; hint?: string }>> = {};
  private busy: DepId | null = null;

  constructor(private deps: InstallerDeps) {}

  get active(): DepId | null {
    return this.busy;
  }

  /** `approved` must come from an explicit user click. Never throws. */
  async install(id: DepId, approved: boolean, probe: DepProbe): Promise<{ ok: boolean; error?: string }> {
    if (!approved) return { ok: false, error: "Not approved." };
    const plan = plansFor(this.deps.env)[id];
    if (!plan) return { ok: false, error: "This item can't be installed from here on this platform." };
    if (this.busy) return { ok: false, error: "Another install is running." };
    if (id === "podman" && probe.podman) return { ok: true };
    this.busy = id;
    this.deps.persist(id);
    const set = (s: { state: DepState; progress?: number; error?: string; hint?: string }) => {
      this.live[id] = s;
      this.deps.onChange();
    };
    set({ state: "installing", progress: 0 });
    try {
      if (id === "podman") {
        const arch = "arm64";
        const bytes = await this.deps.ops.download(podmanPkgUrl(arch), (p) => set({ state: "installing", progress: p }));
        verifySha256(bytes, PODMAN_PKG_SHA256[arch], "podman installer");
        await this.deps.ops.unpackPodmanPkg(bytes);
      }
      delete this.live[id];
      this.deps.onChange();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ state: "failed", error: msg });
      return { ok: false, error: msg };
    } finally {
      this.busy = null;
      this.deps.persist(null);
    }
  }
}
