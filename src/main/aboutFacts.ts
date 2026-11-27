// Facts behind the loopback /desktop/v1/about bridge (Settings > About in the workspace UI).
// Every probe degrades to an explicit { state } instead of a guess; "unknown" is never "no GPU".
import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { statfsSync } from "node:fs";

export interface Fact<T> {
  state: "ok" | "unavailable" | "unknown";
  value?: T;
  reason?: string;
}

export interface VmFacts {
  state: "ok" | "unavailable" | "unknown";
  reason?: string;
  cpus?: number;
  memory_mib?: number;
  disk_gib?: number;
  /** "machine" = read from `podman machine inspect`; "default" = the init defaults aw-desktop passes. */
  source?: "machine" | "default";
}

export interface HostFacts {
  cpus: number;
  mem_total: number;
  mem_free: number;
  disk_total?: number;
  disk_free?: number;
  /** Mac GPU description, or an explicit state. Windows hosts: unavailable in v1. */
  gpu: string | Fact<never>;
}

export const VM_DEFAULTS = { cpus: 2, memory_mib: 4096, disk_gib: 40 } as const;

/** Parse `podman machine inspect` JSON (array of machines). */
export function parseMachineInspect(stdout: string): VmFacts {
  try {
    const parsed = JSON.parse(stdout) as Array<{ Resources?: { CPUs?: number; Memory?: number; DiskSize?: number } }>;
    const r = parsed?.[0]?.Resources;
    if (r && typeof r.CPUs === "number" && typeof r.Memory === "number") {
      return { state: "ok", cpus: r.CPUs, memory_mib: r.Memory, disk_gib: r.DiskSize, source: "machine" };
    }
    return { state: "ok", ...VM_DEFAULTS, source: "default" };
  } catch {
    return { state: "unknown", reason: "podman machine inspect output not parseable" };
  }
}

/** Parse `system_profiler SPDisplaysDataType -json`. Apple Silicon has no dedicated VRAM: say so, print no number. */
export function parseSystemProfilerGpu(stdout: string): string | Fact<never> {
  try {
    const items = (JSON.parse(stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> }).SPDisplaysDataType;
    if (!Array.isArray(items) || items.length === 0) return { state: "unknown", reason: "no display data reported" };
    return items
      .map((g) => {
        const name = String(g["sppci_model"] ?? g["_name"] ?? "GPU");
        const cores = g["sppci_cores"] ? `, ${String(g["sppci_cores"])} cores` : "";
        const vram = g["spdisplays_vram"] ?? g["spdisplays_vram_shared"];
        const apple = name.toLowerCase().startsWith("apple");
        const mem = apple ? ", shares system memory" : vram ? `, ${String(vram)} VRAM` : "";
        return `${name}${cores}${mem}`;
      })
      .join("; ");
  } catch {
    return { state: "unknown", reason: "system_profiler output not parseable" };
  }
}

let gpuCache: Promise<string | Fact<never>> | null = null;

export function hostGpu(platform: NodeJS.Platform = process.platform): Promise<string | Fact<never>> {
  if (platform !== "darwin") return Promise.resolve({ state: "unavailable", reason: "not reported on this platform in v1" });
  gpuCache ??= new Promise((resolve) => {
    execFile("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? { state: "unknown", reason: "system_profiler failed" } : parseSystemProfilerGpu(stdout)),
    );
  });
  return gpuCache;
}

export async function hostFacts(dataRoot: string): Promise<HostFacts> {
  const out: HostFacts = { cpus: cpus().length, mem_total: totalmem(), mem_free: freemem(), gpu: await hostGpu() };
  try {
    const s = statfsSync(dataRoot);
    out.disk_total = s.blocks * s.bsize;
    out.disk_free = s.bavail * s.bsize;
  } catch {
    /* disk facts stay absent: UI shows the host line without them */
  }
  return out;
}

/** Windows: one shared WSL2 VM, not sized per workspace. */
export const WINDOWS_VM: VmFacts = { state: "unavailable", reason: "shared WSL2 VM, not sized per workspace" };
