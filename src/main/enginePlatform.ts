// Platform seam for the bundled container engine (Windows design aw-desktop-windows-local-design-v1,
// ADR 0001 Decision 5). Everything that differs between macOS and Windows lives here: provider, exe
// names, the env podman sees, PATH, tmp root, `machine init` flags, engine-call timeout and tree kill.
// The darwin implementation reproduces the pre-seam behaviour byte for byte. No electron imports.
//
// Windows values marked [W0] are unverified until the Windows spike (card W0) answers them; they sit
// behind this seam so a W0 correction is a one-file change.

export type HostEnv = Readonly<Record<string, string | undefined>>;

export interface MachineSizing {
  cpus?: number;
  memoryMiB?: number;
  diskGiB?: number;
}

export interface EnginePlatform {
  readonly id: "darwin" | "win32";
  /** Executable file name for an engine binary: "podman" -> "podman.exe" on Windows. */
  exeName(name: string): string;
  /** CONTAINERS_MACHINE_PROVIDER / containers.conf provider. */
  provider(arch: string): string;
  /** PATH handed to podman: the engine bin dir first, then the OS dirs the helpers need. */
  path(binDir: string, host?: HostEnv): string;
  /** Short per-workspace tmp parent, given the homes root. */
  tmpRoot(homesRoot: string): string;
  /** The COMPLETE env for podman. `home` is the per-workspace podman HOME, `tmp` its short tmp dir. */
  env(i: { home: string; tmp: string; path: string; provider: string; helperDir: string }, host?: HostEnv): Record<string, string>;
  /** `podman machine init` flags after the machine name. `dataDir` is shared into the VM where supported. */
  machineInitFlags(dataDir: string, sizing: MachineSizing): string[];
  /** Where workspace data lives. "host": bind-mounted from the host filesystem (macOS, virtiofs).
   * "distro": on the machine's own ext4, created through `machine ssh` (Windows: /mnt/c binds are ~9x slower,
   * ignore chown and are case-insensitive, W0 Q5). */
  readonly dataLayout: "host" | "distro";
  /** Root of the per-workspace data inside the distro when dataLayout is "distro". [W0] the WSL machine user is `user`. */
  readonly distroDataRoot: string;
  /** Extra flags for every `run`/`create` of a workspace container. */
  containerFlags(): string[];
  /** Whether the in-place core upgrade is available (Windows v1 defers it, PO decision 1). */
  readonly supportsUpgrade: boolean;
  /** Applied when a caller gave no timeout. 0 = none. */
  readonly defaultTimeoutMs: number;
  /** Kill the whole process tree of a timed-out engine call (wsl.exe and proxy helpers outlive podman.exe). */
  readonly treeKill: boolean;
}

export const darwinPlatform: EnginePlatform = {
  id: "darwin",
  exeName: (n) => n,
  provider: (arch) => (arch === "arm64" ? "libkrun" : "applehv"),
  path: (binDir) => `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  tmpRoot: () => "/tmp",
  env: (i) => ({
    HOME: i.home,
    TMPDIR: i.tmp,
    PATH: i.path,
    CONTAINERS_MACHINE_PROVIDER: i.provider,
    CONTAINERS_HELPER_BINARY_DIR: i.helperDir,
  }),
  machineInitFlags: (dataDir, m) => [
    "--cpus", String(m.cpus ?? 2),
    "--memory", String(m.memoryMiB ?? 4096),
    "--disk-size", String(m.diskGiB ?? 40),
    // HOME is the per-workspace one, so podman's default $HOME:$HOME share would
    // not cover the data dir. Share it explicitly (virtiofs, same path in the VM).
    "--volume", `${dataDir}:${dataDir}`,
  ],
  dataLayout: "host",
  distroDataRoot: "",
  containerFlags: () => [],
  supportsUpgrade: true,
  defaultTimeoutMs: 0,
  treeKill: false,
};

const hostVar = (host: HostEnv, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = host[n] ?? host[n.toUpperCase()];
    if (v) return v;
  }
  return undefined;
};

/** Windows win32 paths are joined by hand: the code under test may run on a POSIX host. */
const wjoin = (...parts: string[]) => parts.join("\\");

export const windowsPlatform: EnginePlatform = {
  id: "win32",
  exeName: (n) => (n.toLowerCase().endsWith(".exe") ? n : `${n}.exe`),
  provider: () => "wsl",
  path: (binDir, host = process.env) => {
    const root = hostVar(host, "SystemRoot", "windir") ?? "C:\\Windows";
    return [binDir, wjoin(root, "System32"), root, wjoin(root, "System32", "wbem")].join(";");
  },
  // Short on purpose; C:\tmp (what "/tmp" resolves to) is not a per-user location.
  tmpRoot: (homesRoot) => wjoin(homesRoot, "t"),
  env: (i, host = process.env) => {
    const out: Record<string, string> = {
      // [W0-unverified] a per-workspace USERPROFILE isolates podman's machine config and connections. W0 ran both
      // machines under the REAL profile (distinct names), so the override itself was never exercised.
      USERPROFILE: i.home,
      HOME: i.home,
      APPDATA: wjoin(i.home, "AppData", "Roaming"),
      LOCALAPPDATA: wjoin(i.home, "AppData", "Local"),
      TEMP: i.tmp,
      TMP: i.tmp,
      PATH: i.path,
      CONTAINERS_MACHINE_PROVIDER: i.provider,
      CONTAINERS_HELPER_BINARY_DIR: i.helperDir,
    };
    // Needed by wsl.exe / podman.exe to locate the system; copied from the host, not invented.
    for (const k of ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "ProgramData", "ProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
      const v = hostVar(host, k);
      if (v) out[k] = v;
    }
    return out;
  },
  // W0 Q4: --cpus/--memory/--disk-size are accepted but NOT enforced under WSL (all distros share one VM sized by
  // .wslconfig; see wslConfig.ts), so none are passed. [W0-unverified] dropping the default C:\\ 9p mount via --volume.
  machineInitFlags: () => [],
  dataLayout: "distro",
  distroDataRoot: "/home/user/aw",
  // W0 Q2: rootless crun fails on every container with "controller 'pids' is not available" under WSL.
  containerFlags: () => ["--pids-limit", "0"],
  supportsUpgrade: false,
  // WSL can hang rather than fail (observed on the Surface): every engine call needs a ceiling.
  defaultTimeoutMs: 120_000,
  treeKill: true,
};

export function platformFor(platform: string = process.platform): EnginePlatform {
  return platform === "win32" ? windowsPlatform : darwinPlatform;
}

