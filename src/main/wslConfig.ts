// Host-side WSL tuning for Windows local workspaces. No electron imports.
//
// W0 Q4/memory: `machine init --cpus/--memory/--disk-size` are accepted under the WSL provider but NOT enforced.
// Every WSL distro (ours, aw-ubuntu, Docker Desktop's) shares ONE VM sized by %USERPROFILE%\.wslconfig, default 50% of
// RAM (3.9 GiB on the 7.9 GiB Surface, where Windows had ~616 MB free at idle). The VM is shared with workspaces this
// app does not own, so the policy is deliberately conservative:
//   - an existing .wslconfig is NEVER edited (it is the user's, and other distros depend on it);
//   - when there is none, write one that does not shrink the VM: it only lets WSL hand page cache back to Windows
//     (`autoMemoryReclaim=gradual`; W0 saw the host-side vmmem dominated by guest cache);
//   - the app never runs `wsl --shutdown`: that would stop aw-ubuntu. A new .wslconfig applies the next time the WSL VM
//     restarts on its own (reboot).
// [W0-unverified] that autoMemoryReclaim takes effect on this WSL build (3.0.1.0, Windows 10), and that the service reads
// .wslconfig from the real profile when a child process runs under an overridden USERPROFILE.

export const WSLCONFIG_MARKER = "# Written by AW Desktop. Delete this file to go back to the WSL defaults.";

export interface WslConfigPlan {
  action: "write" | "leave";
  reason: "absent" | "exists";
  contents?: string;
}

export function planWslConfig(existing: string | null): WslConfigPlan {
  if (existing !== null) return { action: "leave", reason: "exists" };
  return { action: "write", reason: "absent", contents: `${WSLCONFIG_MARKER}\n[experimental]\nautoMemoryReclaim=gradual\n` };
}

/** Best effort: a failure here never blocks a workspace. `realHome` is the REAL user profile (not the per-workspace one). */
export function ensureWslConfig(
  realHome: string,
  io: { read(p: string): string | null; write(p: string, data: string): void },
  log: (msg: string) => void = () => undefined,
): WslConfigPlan {
  const path = `${realHome}\\.wslconfig`;
  let plan: WslConfigPlan;
  try {
    plan = planWslConfig(io.read(path));
    if (plan.action === "write" && plan.contents) {
      io.write(path, plan.contents);
      log(`wrote ${path}; it applies when the WSL VM next restarts (the app never runs wsl --shutdown)`);
    }
  } catch (err) {
    log(`could not write .wslconfig: ${err instanceof Error ? err.message : String(err)}`);
    return { action: "leave", reason: "exists" };
  }
  return plan;
}
