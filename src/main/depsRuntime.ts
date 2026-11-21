import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import type { DepId, DepsSnapshot } from "../shared/deps";
import { buildSnapshot, DepInstaller, type DepProbe, type InstallOps } from "./dependencies";

const env = () => ({ platform: process.platform, arch: process.arch });
const podmanBin = () => join(homedir(), "podman-dist", "podman", "bin", "podman");

function run(file: string, args: string[], timeout = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) : 0;
      resolve({ code: typeof code === "number" ? code : err ? null : 0, out: `${stdout}\n${stderr}` });
    }),
  );
}

export async function realProbe(): Promise<DepProbe> {
  const p = podmanBin();
  const podman = existsSync(p) && (await run(p, ["--version"], 8000)).code === 0;
  // The machine row no longer probes any runtime: a machine is created per workspace,
  // and an answering runtime here would be the live workspace's default machine.
  return { podman };
}

async function downloadWithProgress(url: string, onProgress: (p: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks: Uint8Array[] = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total > 0) onProgress(Math.min(99, Math.floor((got / total) * 100)));
  }
  return Buffer.concat(chunks);
}

const realOps: InstallOps = {
  download: (url, onProgress) => downloadWithProgress(url, onProgress),
  unpackPodmanPkg: async (pkg) => {
    const dir = mkdtempSync(join(tmpdir(), "aw-podman-"));
    try {
      const file = join(dir, "pkg.pkg");
      writeFileSync(file, pkg);
      const expanded = join(dir, "expanded");
      const r = await run("/usr/sbin/pkgutil", ["--expand-full", file, expanded], 300_000);
      if (r.code !== 0) throw new Error(`pkgutil failed: ${r.out.trim().slice(-300)}`);
      const f = await run("/usr/bin/find", [expanded, "-type", "d", "-name", "podman", "-print", "-quit"]);
      const found = f.out.split("\n")[0]?.trim();
      if (!found) throw new Error("could not find the podman directory inside the installer");
      const dest = join(homedir(), "podman-dist", "podman");
      mkdirSync(join(homedir(), "podman-dist"), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      cpSync(found, dest, { recursive: true });
      const dist = join(homedir(), "podman-dist");
      writeFileSync(
        join(dist, "env.sh"),
        `export PATH="${dist}/podman/bin:$PATH"\nexport CONTAINERS_HELPER_BINARY_DIR="${dist}/podman/bin"\nexport CONTAINERS_MACHINE_PROVIDER=applehv\n`,
      );
      if (!existsSync(join(dest, "bin", "podman"))) throw new Error("installer did not produce bin/podman");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

const markerFile = () => join(app.getPath("userData"), "deps-install.json");
function readMarker(): DepId | undefined {
  try {
    return (JSON.parse(readFileSync(markerFile(), "utf8")) as { installing?: DepId }).installing;
  } catch {
    return undefined;
  }
}

let installer: DepInstaller | null = null;
let notify: () => void = () => undefined;
let interrupted: DepId | undefined;

export function initDeps(onChange: () => void): void {
  notify = onChange;
  // A marker left by a previous run means the app quit mid-install.
  interrupted = readMarker();
  installer = new DepInstaller({
    ops: realOps,
    env: env(),
    persist: (m) => {
      try {
        writeFileSync(markerFile(), JSON.stringify({ installing: m ?? undefined }));
      } catch {
        // best effort
      }
    },
    onChange: () => notify(),
  });
}

export async function depsSnapshot(): Promise<DepsSnapshot> {
  const probe = await realProbe();
  const snap = buildSnapshot(env(), probe, installer?.live ?? {}, interrupted);
  // Once the probe says everything is fine, an old interrupted marker is stale.
  if (snap.ready) interrupted = undefined;
  return snap;
}

export async function depsInstall(id: DepId, approved: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!installer) return { ok: false, error: "not ready" };
  interrupted = undefined;
  return installer.install(id, approved, await realProbe());
}
