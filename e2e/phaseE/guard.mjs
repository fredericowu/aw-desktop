// Pure helpers for the Phase E harness: the hermetic podman environment and the host-integrity
// comparison. No imports from common.mjs (that one launches Electron deps and creates dirs), so
// test/phaseEGuard.test.ts can import this file directly.
import { dirname, join } from "node:path";

export const HOST_MACHINE = "podman-machine-default";
export const HOST_HEALTH_URL = "http://127.0.0.1:9030/api/health";
const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The provider the app itself hands podman (src/main/localRuntime.ts machineProvider). */
export const machineProvider = (arch = process.arch) => (arch === "arm64" ? "libkrun" : "applehv");

/**
 * The COMPLETE environment for a podman call made on behalf of one workspace: exactly the four
 * variables the app passes (src/main/localRuntime.ts podmanEnv). Nothing is inherited, so XDG_* or
 * CONTAINER_* from the caller can never point the call at the user's real podman config.
 */
export function workspacePodmanEnv(podmanBin, homesRoot, id, tmpRoot = "/tmp", arch = process.arch) {
  return {
    HOME: join(homesRoot, id, "home"),
    TMPDIR: join(tmpRoot, `aw-${id}`),
    PATH: `${dirname(podmanBin)}:${BASE_PATH}`,
    CONTAINERS_MACHINE_PROVIDER: machineProvider(arch),
  };
}

/** Env for non-podman helpers (lsof, pgrep): PATH only. */
export const toolEnv = () => ({ PATH: BASE_PATH });

/**
 * Parse `podman machine list --format "{{.Name}}\t{{.Running}}"` output into the host VM's state:
 * "running" | "stopped" | "absent".
 */
export function parseHostMachine(out) {
  for (const line of String(out).split("\n")) {
    const [name, running] = line.trim().split("\t");
    if ((name ?? "").replace(/\*$/, "") === HOST_MACHINE) return String(running).trim() === "true" ? "running" : "stopped";
  }
  return "absent";
}

/** before/after are {machine, health}; returns null when identical, else a human-readable message. */
export function hostIntegrityError(before, after) {
  if (before.machine === "unknown" || after.machine === "unknown") {
    return `could not verify ${HOST_MACHINE} state: before=${before.machine}, after=${after.machine}`;
  }
  const diffs = [];
  if (before.machine !== after.machine) diffs.push(`${HOST_MACHINE} ${before.machine} -> ${after.machine}`);
  if (before.health !== after.health) diffs.push(`:9030 health ${before.health} -> ${after.health}`);
  return diffs.length ? `host state changed during the run: ${diffs.join("; ")}` : null;
}
