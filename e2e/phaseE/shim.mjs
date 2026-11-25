// Failure-injection shim for the recovery drivers (recovery.mjs). Pure helpers plus one fs routine; no
// Electron/Playwright imports so test/phaseERecovery.test.ts can import this file directly.
//
// The app is launched with AW_DESKTOP_ENGINE_DIR pointing at a COPY of its bundled engine whose `podman`
// is a bash shim: it logs every call, injects a raw failure for one subcommand according to the mode file,
// and otherwise execs the real binary (renamed podman.real). The installed app bundle is never modified.
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MODES = ["pass", "noengine", "startfail", "slowstart", "nospace", "dns"];
// Raw text the shim emits. Harness assertions look for the RAWMARK-* tokens to prove the raw failure reached
// diagnostics.log / the clipboard but never the rendered UI. SECRET value proves redaction.
export const SECRET = "sk-live-SECRET123";

/** bash source of the shim. `workDir` holds the `mode` and `calls.log` files. */
export function shimScript(workDir) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash
# e2e shim: logs every call, injects failures per the mode file, otherwise execs the real bundled podman.
D=${q(workDir)}; mkdir -p "$D"
echo "$(date +%T) $*" >> "$D/calls.log"
MODE=$(cat "$D/mode" 2>/dev/null || echo pass)
ARGS=" $* "
case "$MODE" in
  noengine) [[ "$ARGS" == *" --version "* ]] && { echo "dyld: Library not loaded RAWMARK-noengine" >&2; exit 1; } ;;
  startfail) [[ "$ARGS" == *" machine start "* ]] && { echo "Error: unable to start host networking: gvproxy exited; krunkit failed API_KEY=${SECRET} /tmp/podman.sock RAWMARK-startfail" >&2; exit 125; } ;;
  slowstart) [[ "$ARGS" == *" machine start "* ]] && sleep 45 ;;
  nospace) [[ "$ARGS" == *" machine init "* ]] && { echo "Error: write /var/data: no space left on device RAWMARK-nospace" >&2; exit 125; } ;;
  dns) [[ "$ARGS" == *" pull "* || "$ARGS" == *" machine init "* ]] && { echo "Error: pulling image: Get https://registry: dial tcp: lookup registry: no such host RAWMARK-dns" >&2; exit 125; } ;;
esac
exec "$(dirname "$0")/podman.real" "$@"
`;
}

/**
 * Copy the engine dir `src` to `dest`, move its `bin/podman` to `bin/podman.real` and install the shim as
 * `bin/podman`. Idempotent: a second call only rewrites the shim. Refuses to touch `src` itself.
 */
export function prepareEngine(src, dest, workDir) {
  if (resolve(src) === resolve(dest)) throw new Error("refusing to shim the installed engine in place");
  const bin = join(dest, "bin");
  if (!existsSync(join(bin, "podman.real"))) {
    if (!existsSync(join(src, "bin/podman"))) throw new Error(`no engine at ${src} (expected bin/podman)`);
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    renameSync(join(bin, "podman"), join(bin, "podman.real"));
  }
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(bin, "podman"), shimScript(workDir));
  chmodSync(join(bin, "podman"), 0o755);
  return { bin, real: join(bin, "podman.real") };
}
