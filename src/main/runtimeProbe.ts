import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { RuntimeCheck, RuntimeKind, RuntimeStatus } from "../shared/types";

/** Injectable side effects so the probe is unit-testable off a Mac. */
export interface ProbeDeps {
  home: string;
  exists(path: string): boolean;
  /** Resolves the exit code (null on spawn failure / timeout). */
  run(file: string, args: string[], timeoutMs: number): Promise<number | null>;
}

const PROBE_TIMEOUT_MS = 8000;

/** Absolute paths only. A Finder/Dock-launched Electron app does NOT inherit
 * the login-shell PATH, so a bare `podman` would report "missing" for a
 * perfectly good Homebrew install. */
export function candidatePaths(kind: RuntimeKind, home: string): string[] {
  switch (kind) {
    case "podman":
      return [
        "/opt/homebrew/bin/podman",
        "/usr/local/bin/podman",
        "/opt/podman/bin/podman",
        // Vendored by aw-remote-host's bootstrap/podman/install.sh (no brew).
        `${home}/podman-dist/podman/bin/podman`,
      ];
    case "docker-desktop":
      return [
        "/Applications/Docker.app/Contents/Resources/bin/docker",
        `${home}/Applications/Docker.app/Contents/Resources/bin/docker`,
        "/usr/local/bin/docker",
      ];
    case "colima":
      return ["/opt/homebrew/bin/colima", "/usr/local/bin/colima"];
  }
}

/** Docker Desktop is detected by its .app bundle (the docker CLI alone could
 * be a colima shim). */
const DOCKER_APP_BUNDLES = (home: string) => [
  "/Applications/Docker.app",
  `${home}/Applications/Docker.app`,
];

function runningArgs(kind: RuntimeKind): string[] {
  return kind === "colima" ? ["status"] : ["info"];
}

async function probeOne(kind: RuntimeKind, deps: ProbeDeps): Promise<RuntimeStatus> {
  const path = candidatePaths(kind, deps.home).find((p) => deps.exists(p));
  const bundleInstalled =
    kind === "docker-desktop" && DOCKER_APP_BUNDLES(deps.home).some((p) => deps.exists(p));
  // Docker Desktop needs the .app bundle; a lone /usr/local/bin/docker is not
  // proof of Docker Desktop.
  const installed =
    kind === "docker-desktop" ? bundleInstalled && path !== undefined : path !== undefined;
  if (!installed || !path) return { kind, installed: false, running: false };
  const code = await deps.run(path, runningArgs(kind), PROBE_TIMEOUT_MS);
  return { kind, installed: true, running: code === 0, path };
}

const KINDS: RuntimeKind[] = ["podman", "docker-desktop", "colima"];

export async function probeRuntimes(deps: ProbeDeps = defaultDeps()): Promise<RuntimeCheck> {
  const runtimes = await Promise.all(KINDS.map((k) => probeOne(k, deps)));
  return { runtimes, ready: runtimes.some((r) => r.installed && r.running) };
}

export function defaultDeps(): ProbeDeps {
  return {
    home: homedir(),
    exists: (p) => existsSync(p),
    run: (file, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout: timeoutMs }, (err) => {
          if (!err) return resolve(0);
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          resolve(typeof code === "number" ? code : null);
        });
      }),
  };
}
