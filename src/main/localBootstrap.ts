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
  /** Stops the bootstrap child AND its descendants (installer scripts, curl), resolving once they are gone. */
  killBootstrap(): Promise<void>;
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
  /** remote_host_id the control plane has on the row, for resuming a partial registration. */
  getRowHostId?(slug: string): Promise<string | null>;
  /** Control plane the token was minted against; passed to the CLI as --control-plane. */
  controlPlane?: string;
  emit(p: BootstrapProgress): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Bound on the bootstrap child itself (it downloads Podman with no deadline of its own). */
  bootstrapTimeoutMs?: number;
  signal?: AbortSignal;
}

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
export const BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;

/** Pre-flight for resuming `slug`. When status shows a linked host with no
 * workspace slug (partial registration) the row's host id is checked against
 * the control plane before refusing, so the original row stays resumable. */
export async function preflightFor(
  host: LocalHostStatus,
  slug: string | undefined,
  getRowHostId?: (slug: string) => Promise<string | null>,
) {
  let rowHostId: string | null = null;
  if (slug && getRowHostId && host.linked && !host.unknown && host.remoteHostId) {
    rowHostId = await getRowHostId(slug).catch(() => null);
  }
  return decidePreflight(host, slug, rowHostId);
}

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
    const pre = await preflightFor(host, slug, deps.getRowHostId);
    if (pre.action === "block") throw new Error(pre.message);

    let binary = host.binary ? deps.ops.findBinary() : null;
    if (!binary) binary = await deps.ops.installBinary(line);

    let token: string | null = null;
    if (pre.needsToken) {
      push(advance(p, "token"));
      token = await deps.mintToken(slug);
    }

    // Signed out while installing/minting: never launch the CLI for a dead session.
    if (deps.signal?.aborted) throw new Error("cancelled");
    push(advance(p, "link"));
    const code = await runBounded(deps, binary, token, line);
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

/** The child can hang (its Podman download has no deadline): bound it, kill it,
 * and fail so Retry is offered instead of holding the setup slot forever. */
async function runBounded(
  deps: FlowDeps,
  binary: string,
  token: string | null,
  onLine: (l: string) => void,
): Promise<number | null> {
  const ms = deps.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<"timeout" | "cancelled">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    // Sign-out mid-bootstrap: stop the child instead of letting it link this Mac for a dead session.
    onAbort = () => resolve("cancelled");
    if (deps.signal?.aborted) onAbort();
    else deps.signal?.addEventListener("abort", onAbort);
  });
  try {
    const r = await Promise.race([deps.ops.runBootstrap(binary, token, deps.controlPlane, onLine), timeout]);
    if (r === "cancelled") {
      await deps.ops.killBootstrap();
      throw new Error("cancelled");
    }
    if (r === "timeout") {
      // Retry must not start while the old installer tree could still write Podman files.
      await deps.ops.killBootstrap();
      throw new Error(`aw-remote-host setup did not finish within ${Math.round(ms / 60000)} minutes (a download may have stalled). Retry to continue.`);
    }
    return r;
  } finally {
    clearTimeout(timer);
    if (onAbort) deps.signal?.removeEventListener("abort", onAbort);
  }
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

/** Ties a setup job to the sign-in session that started it. `end()` (sign-out)
 * invalidates every job begun before it: they stop emitting, lose token access,
 * abort their poll and must not auto-open a workspace for whoever signs in next. */
export interface SessionHandle {
  isCurrent(): boolean;
  signal: AbortSignal;
  finish(): void;
}

export class SessionScope {
  private epoch = 0;
  private jobs = new Set<AbortController>();
  begin(): SessionHandle {
    const epoch = this.epoch;
    const ac = new AbortController();
    this.jobs.add(ac);
    return {
      isCurrent: () => epoch === this.epoch,
      signal: ac.signal,
      finish: () => void this.jobs.delete(ac),
    };
  }
  end(): void {
    this.epoch++;
    for (const ac of this.jobs) ac.abort();
    this.jobs.clear();
  }
}

/** `exclusive` + a session handle begun SYNCHRONOUSLY at entry (before any
 * await), so work that outlives a sign-out/sign-in is judged against the
 * session that asked for it. The handle is finished unless `handOff()` ran. */
export function scopedExclusive<T>(
  slot: SetupSlot,
  scope: SessionScope,
  busy: T,
  work: (session: SessionHandle, handOff: () => void) => Promise<T>,
): Promise<T> {
  return exclusive(slot, busy, async (slotHandOff) => {
    const session = scope.begin();
    let started = false;
    try {
      return await work(session, () => {
        started = true;
        slotHandOff();
      });
    } finally {
      if (!started) session.finish();
    }
  });
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

export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Download with a hard deadline covering the body read: a release response
 * that trickles bytes forever must fail (so Retry is offered) rather than
 * hold the setup slot until Desktop restarts. */
export async function fetchBytes(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<Uint8Array> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (timedOut) throw new Error(`download timed out for ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Vendored Podman dir that aw-remote-host itself installs and resolves. */
export const vendoredPodmanDir = (home: string) => `${home}/podman-dist/podman/bin`;
/** launchd's default PATH: what the detached LaunchAgent will see. */
export const LAUNCHD_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** PATH for the bootstrap child = PATH the LaunchAgent will have, regardless of
 * how Desktop was launched (Finder vs terminal).
 *
 * Why: with --background the CLI only runs infra and detaches; the workspace
 * install then completes INSIDE the LaunchAgent (control-plane "bootstrap"
 * verb), whose plist carries no PATH (aw-remote-host v0.1.150
 * servicemgr/launchd.go) and which looks podman up by name. If the child saw a
 * Homebrew podman it would skip the vendored install and hand over to an agent
 * that cannot see that podman. So Homebrew/`/usr/local` dirs are deliberately
 * NOT on this PATH: a detected Homebrew Podman is deliberately not reused while
 * the pin is v0.1.150 (Desktop installs its own vendored copy next to it).
 * Side effect: Docker Desktop's CLI (`/usr/local/bin/docker`) is not visible
 * either, so the CLI's podman installer does not exit early on `docker info`
 * and always reaches `podman machine start`.
 * Revisit when the pin moves past the aw-remote-host fix that resolves a
 * non-vendored podman for the agent. The CLI is spawned by absolute path. */
export function childEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...env, PATH: `${vendoredPodmanDir(home)}:${LAUNCHD_DEFAULT_PATH}` };
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
      const fetchBuf = (url: string) => fetchBytes(url);
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
        // detached => own process group, so the whole tree (bash installer, curl) can be killed.
        const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv(process.env, homedir()), detached: true });
        child.stdout.on("data", splitLines(onLine));
        child.stderr.on("data", splitLines(onLine));
        child.on("error", (e) => {
          onLine(`spawn failed: ${e.message}`);
          resolve(null);
        });
        activeDone = new Promise<void>((done) => {
          child.on("close", () => done());
          child.on("error", () => done());
        });
        child.on("close", (code) => resolve(code));
        activeChild = child;
      }),
    killBootstrap: killActiveBootstrap,
  };
}

let activeChild: ReturnType<typeof spawn> | null = null;
let activeDone: Promise<void> = Promise.resolve();

/** SIGKILL the child's whole process group (pid is the group leader because it
 * was spawned detached), then wait (bounded) for it to exit. */
export async function killActiveBootstrap(): Promise<void> {
  const child = activeChild;
  activeChild = null;
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.race([activeDone, new Promise<void>((r) => setTimeout(r, 5000))]);
}
