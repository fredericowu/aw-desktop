import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { podmanBinPath, runtimeConfig } from "./localWorkspaces";
import type { PreflightResult } from "../shared/preflight";
import { runPreflight, type PreflightProbe } from "./preflightCore";

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
    hypervisorSupported: hvSupport,
  };
}

export const preflight = (): Promise<PreflightResult> => realProbe().then(runPreflight);
