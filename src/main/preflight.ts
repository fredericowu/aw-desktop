import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { podmanBinPath, runtimeConfig } from "./localWorkspaces";
import type { PreflightResult } from "../shared/preflight";
import { runPreflight, type PreflightProbe } from "./preflightCore";
import { makeExecRunner, type Runner } from "./localRuntime";
import { platformFor } from "./enginePlatform";

function hvSupport(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile("/usr/sbin/sysctl", ["-n", "kern.hv_support"], { timeout: 5000 }, (err, out) => resolve(!err && out.trim() === "1")),
  );
}

function engineRuns(): Promise<boolean> {
  const bin = podmanBinPath();
  if (!existsSync(bin)) return Promise.resolve(false);
  return new Promise((resolve) => execFile(bin, ["--version"], { timeout: 8000 }, (err) => resolve(!err)));
}

/** Windows: `wsl.exe --status` through the tree-killing runner. Output is UTF-16 and ignored; only the outcome matters.
 * [W0-unverified] the exit code wsl.exe returns when WSL is not installed (assumed non-zero); a hung WSLService (seen
 * on the Surface after boot with WslInstaller running) shows as a timeout. */
export async function wslState(run: Runner = makeExecRunner(platformFor()), env: Record<string, string> = process.env as Record<string, string>): Promise<"ready" | "missing" | "unresponsive"> {
  const root = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  const r = await run(`${root}\\System32\\wsl.exe`, ["--status"], { env, timeoutMs: WSL_PROBE_TIMEOUT_MS });
  if (r.code === 0) return "ready";
  return /timed out after/.test(r.stderr) ? "unresponsive" : "missing";
}
export const WSL_PROBE_TIMEOUT_MS = 15_000;

async function realProbe(): Promise<PreflightProbe> {
  const home = homedir();
  let free = Number.POSITIVE_INFINITY;
  try {
    const s = statfsSync(home);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    // Unreadable: let the real start report it rather than blocking on a guess.
  }
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemBytes: totalmem(),
    freeDiskBytes: free,
    homesRoot: runtimeConfig("", home).homesRoot,
    engineRuns: await engineRuns(),
    hypervisorSupported: process.platform === "darwin" ? hvSupport : async () => true,
    ...(process.platform === "win32"
      ? {
          wslState: () => wslState(),
          sshAvailable: () => existsSync(`${process.env["SystemRoot"] ?? process.env["windir"] ?? "C:\\Windows"}\\System32\\OpenSSH\\ssh.exe`),
        }
      : {}),
  };
}

export const preflight = (): Promise<PreflightResult> => realProbe().then(runPreflight);
