import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapProgress, LocalHostStatus } from "../shared/types";
import {
  AW_REMOTE_HOST_VERSION,
  advance,
  appendLine,
  assetName,
  complete,
  decidePreflight,
  fail,
  parseStatus,
  releaseUrl,
  startProgress,
  verifyChecksum,
} from "./bootstrapCore";

/** Side effects, injectable so the flow is testable off a Mac. */
export interface HostOps {
  /** Path of an installed aw-remote-host, or null. */
  findBinary(): string | null;
  /** True if ~/.aw-remote-host/credentials.json exists. */
  hasCredentials(): boolean;
  /** Runs `aw-remote-host status`, returning combined output (exit code ignored: status exits 1 when degraded). */
  runStatus(binary: string): Promise<string | null>;
  /** Download+verify+install the pinned release; returns the installed path. */
  installBinary(onLine: (l: string) => void): Promise<string>;
  /** Runs bootstrap-workspace; resolves the exit code. Token is passed via argv only. */
  runBootstrap(binary: string, token: string | null, controlPlane: string | undefined, onLine: (l: string) => void): Promise<number | null>;
}

export async function readHostStatus(ops: Pick<HostOps, "findBinary" | "hasCredentials" | "runStatus">): Promise<LocalHostStatus> {
  const binary = ops.findBinary();
  if (!binary) {
    // No CLI we can ask. Existing credentials still mean "linked": never guess clean.
    return ops.hasCredentials() ? { binary: false, linked: true, unknown: true } : { binary: false, linked: false };
  }
  const out = await ops.runStatus(binary);
  if (out === null) return { binary: true, linked: true, unknown: true };
  return { binary: true, ...parseStatus(out) };
}

export interface FlowDeps {
  ops: HostOps;
  mintToken(slug: string): Promise<string>;
  /** Must honour `signal`; the flow also races it against the deadline. */
  getStatus(slug: string, signal: AbortSignal): Promise<string>;
  /** Control plane the token was minted against; passed to the CLI as --control-plane. */
  controlPlane?: string;
  emit(p: BootstrapProgress): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  signal?: AbortSignal;
}

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

/** Brings up the local workspace for an EXISTING row `slug`. Pre-flight runs
 * first (so a linked Mac is refused before a token is minted). Never throws:
 * failure is a `failed` progress with the failing step and last log lines. */
export async function runBootstrapFlow(slug: string, deps: FlowDeps): Promise<BootstrapProgress> {
  let p = startProgress(slug);
  const push = (next: BootstrapProgress) => {
    p = next;
    deps.emit(p);
  };
  const line = (l: string) => push(appendLine(p, l));
  try {
    push(advance(p, "cli"));
    let host = await readHostStatus(deps.ops);
    const pre = decidePreflight(host, slug);
    if (pre.action === "block") throw new Error(pre.message);

    let binary = host.binary ? deps.ops.findBinary() : null;
    if (!binary) binary = await deps.ops.installBinary(line);

    let token: string | null = null;
    if (pre.needsToken) {
      push(advance(p, "token"));
      token = await deps.mintToken(slug);
    }

    push(advance(p, "link"));
    const code = await deps.ops.runBootstrap(binary, token, deps.controlPlane, line);
    token = null;
    if (code !== 0) throw new Error(`aw-remote-host bootstrap-workspace exited with ${code === null ? "an error" : `code ${code}`}`);

    push(advance(p, "running"));
    const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = deps.now() + (deps.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    for (;;) {
      if (deps.signal?.aborted) throw new Error("cancelled");
      const status = await pollOnce(deps, slug, deadline - deps.now());
      if (status === "running") break;
      if (deps.now() > deadline) throw new Error(`workspace did not reach running (last status: ${status || "unknown"})`);
      await deps.sleep(interval);
    }
    push(complete(p));
  } catch (err) {
    push(fail(p, err instanceof Error ? err.message : String(err)));
  }
  return p;
}

/** Single-flight slot for "a setup is running on this Mac". */
export class SetupSlot {
  private busy = false;
  claim(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  release(): void {
    this.busy = false;
  }
  get isBusy(): boolean {
    return this.busy;
  }
}

/** Claims the slot SYNCHRONOUSLY (before any await), runs `work`, and releases
 * on every exit unless `work` called `handOff()` (the background bootstrap then
 * owns the slot and must release it). Two rapid calls can never both pass. */
export async function exclusive<T>(slot: SetupSlot, busy: T, work: (handOff: () => void) => Promise<T>): Promise<T> {
  if (!slot.claim()) return busy;
  let handedOff = false;
  try {
    return await work(() => {
      handedOff = true;
    });
  } finally {
    if (!handedOff) slot.release();
  }
}

/** One status poll bounded by the remaining budget: a request that stalls
 * after headers (or a dep that ignores the signal) cannot wedge the loop. */
async function pollOnce(deps: FlowDeps, slug: string, remainingMs: number): Promise<string> {
  const budget = Math.max(1, Math.min(remainingMs, 30_000));
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve("");
    }, budget);
  });
  try {
    return await Promise.race([deps.getStatus(slug, ac.signal).catch(() => ""), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- real implementation -------------------------------------------------

const INSTALL_DIR = () => join(homedir(), ".local", "bin");

function binaryCandidates(): string[] {
  return [join(INSTALL_DIR(), "aw-remote-host"), "/usr/local/bin/aw-remote-host", "/opt/homebrew/bin/aw-remote-host"];
}

function splitLines(onLine: (l: string) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const l of parts) onLine(l);
  };
}

/** argv for the CLI. The CLI defaults to the hosted control plane; a
 * self-hosted desktop (AW_DESKTOP_APEX) must hand it the one the token was
 * minted against, or the token goes to the wrong deployment. */
export function bootstrapArgs(token: string | null, controlPlane?: string): string[] {
  const args = ["bootstrap-workspace", "--with-workspace", "--yes", "--background"];
  if (token) args.push("--token", token);
  if (controlPlane) args.push("--control-plane", controlPlane);
  return args;
}

export function realHostOps(): HostOps {
  return {
    findBinary: () => binaryCandidates().find((p) => existsSync(p)) ?? null,
    hasCredentials: () => existsSync(join(homedir(), ".aw-remote-host", "credentials.json")),
    runStatus: (binary) =>
      new Promise((resolve) => {
        execFile(binary, ["status"], { timeout: 30_000 }, (err, stdout, stderr) => {
          const out = `${stdout}\n${stderr}`;
          // status exits non-zero when degraded but still prints a parseable report.
          if (err && !/linked: (yes|no)/.test(out)) return resolve(null);
          resolve(out);
        });
      }),
    installBinary: async (onLine) => {
      const version = AW_REMOTE_HOST_VERSION;
      const asset = assetName(version, process.platform, process.arch);
      onLine(`aw-remote-host: downloading ${asset} (${version})`);
      const fetchBuf = async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
        return new Uint8Array(await res.arrayBuffer());
      };
      const tarball = await fetchBuf(releaseUrl(version, asset));
      const checksums = Buffer.from(await fetchBuf(releaseUrl(version, "checksums.txt"))).toString("utf8");
      onLine("aw-remote-host: verifying checksum");
      verifyChecksum(tarball, checksums, asset);
      const dir = mkdtempSync(join(tmpdir(), "aw-rh-"));
      try {
        const tgz = join(dir, asset);
        writeFileSync(tgz, tarball);
        await new Promise<void>((resolve, reject) =>
          execFile("/usr/bin/tar", ["-xzf", tgz, "-C", dir, "aw-remote-host"], (e) => (e ? reject(e) : resolve())),
        );
        mkdirSync(INSTALL_DIR(), { recursive: true });
        const dest = join(INSTALL_DIR(), "aw-remote-host");
        copyFileSync(join(dir, "aw-remote-host"), dest);
        chmodSync(dest, 0o755);
        onLine(`aw-remote-host: installed to ${dest}`);
        return dest;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    runBootstrap: (binary, token, controlPlane, onLine) =>
      new Promise((resolve) => {
        const args = bootstrapArgs(token, controlPlane);
        const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", splitLines(onLine));
        child.stderr.on("data", splitLines(onLine));
        child.on("error", (e) => {
          onLine(`spawn failed: ${e.message}`);
          resolve(null);
        });
        child.on("close", (code) => resolve(code));
        activeChild = child;
      }),
  };
}

let activeChild: ReturnType<typeof spawn> | null = null;

/** App quit mid-bootstrap: stop the child. The server row stays, so the next
 * launch offers "Finish setup" and re-runs the (idempotent) bootstrap. */
export function killActiveBootstrap(): void {
  activeChild?.kill("SIGTERM");
  activeChild = null;
}


