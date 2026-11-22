import type { PreflightCode, PreflightResult } from "../shared/preflight";

const GIB = 1024 ** 3;
/** Each local workspace is one 4 GiB VM; below 8 GiB total the Mac cannot also run itself. */
export const MIN_TOTAL_MEMORY_BYTES = 8 * GIB;
/** ADR 0001: refuse to create with less than 15 GiB free. */
export const MIN_FREE_DISK_BYTES = 15 * GIB;
/** macOS sun_path limit, minus the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;
/** Longest per-workspace socket path the app creates: id is "local" + 6 hex. */
const SOCKET_SUFFIX = "localf7823d/home/.podman/aw-localf7823d-ignition.sock";

/** What the host looks like. Injectable so the checks run off a Mac. */
export interface PreflightProbe {
  platform: string;
  arch: string;
  totalMemBytes: number;
  freeDiskBytes: number;
  /** Absolute path of the per-workspace homes root (~/.awd). */
  homesRoot: string;
  /** The bundled engine binary exists AND runs (`--version` exits 0). */
  engineRuns: boolean;
  hypervisorSupported(): Promise<boolean>;
}

const msg = (code: PreflightCode, extra = ""): PreflightResult => ({
  ok: false,
  code,
  message: {
    virtualization_unavailable: "This Mac can't run local workspaces.",
    low_disk: `Not enough free disk space. Free up ${extra} GB and try again.`,
    low_memory: "Not enough memory to start a local workspace.",
    engine_missing: "AW Desktop is incomplete. Reinstall it and try again.",
    path_too_long: "This Mac's account name is too long to run local workspaces.",
  }[code],
});

/** Pure given a probe. First failing check wins; cheap checks run before the hypervisor query. */
export async function runPreflight(p: PreflightProbe): Promise<PreflightResult> {
  if (p.platform !== "darwin" || p.arch !== "arm64") return msg("virtualization_unavailable");
  if (!p.engineRuns) return msg("engine_missing");
  if (Buffer.byteLength(`${p.homesRoot}/${SOCKET_SUFFIX}`) > MAX_SOCKET_PATH_BYTES) return msg("path_too_long");
  if (p.totalMemBytes < MIN_TOTAL_MEMORY_BYTES) return msg("low_memory");
  if (p.freeDiskBytes < MIN_FREE_DISK_BYTES) {
    return msg("low_disk", String(Math.max(1, Math.ceil((MIN_FREE_DISK_BYTES - p.freeDiskBytes) / GIB))));
  }
  let hv = false;
  try {
    hv = await p.hypervisorSupported();
  } catch {
    hv = false;
  }
  return hv ? { ok: true } : msg("virtualization_unavailable");
}
