# Phase E e2e: standalone local workspaces on a real Mac

Drives the **installed `AW Desktop.app`** (Playwright `_electron`) through the
standalone local-workspace path against real podman: Keychain/session handling,
creating two local workspaces, the served UI, and the free-tier cap. It then
tears everything down and checks nothing leaked. **Not wired into PR CI**: it
needs a real Mac and takes several minutes (machine init + image pulls).

## Prerequisites

- A Mac with a **logged-in GUI session**. A headless/ssh-only session cannot
  answer the Keychain prompt and the app blocks.
- `AW Desktop.app` installed (default `/Applications/AW Desktop.app`).
- The engine bundled inside the app (`<app>/Contents/Resources/engine/bin/podman`). `~/podman-dist` is not used.
- Other workspaces are safe: teardown/leftovers only touch the ids the run itself
  created (taken from the registry entry for each name the harness chose), never
  anything another profile adds mid-run. The run waits on the port the registry
  assigned to its workspace, so a stopped workspace holding 9031/9032 no longer
  stalls it. Busy ports 9031-9034 are snapshotted and excluded from the port check.
- Ports 9031-9034 free, `playwright-core` (`npm ci`, no browser download).
- A test-account JWT in a file (never commit it).

## Environment

| Var | Meaning | Default |
|---|---|---|
| `AW_E2E_JWT_FILE` | **required**, file holding the test-account JWT | none |
| `AW_E2E_APP` | app bundle | `/Applications/AW Desktop.app` |
| `AW_E2E_USER_DATA` | app userData dir (the app is launched with `--user-data-dir` set to it, so harness and app share it; use a throwaway dir to leave your real profile alone) | `~/Library/Application Support/aw-desktop` |
| `AW_E2E_PODMAN` | podman binary | `<AW_E2E_APP>/Contents/Resources/engine/bin/podman` |
| `AW_E2E_RESET_AUTH` | `1` = move `session.bin`/`safestorage-*` in the userData dir to a backup subdir before step 5 (a stale `safestorage-disabled` flag breaks the relaunch check). Refuses to run if a plaintext `session.json` exists. Off by default: the default userData is the installed app's real profile | unset |
| `AW_E2E_SHOTS` | screenshot/text output | `./.tmp/phaseE-shots` |

## How to run

```bash
npm ci
AW_E2E_JWT_FILE=/path/to/jwt.txt npm run e2e:phaseE              # run, report leftovers
AW_E2E_JWT_FILE=/path/to/jwt.txt npm run e2e:phaseE -- --teardown # run, then clean up and assert clean
```

Start from a clean state (empty registry, no `local*` dirs) or the counts below will be off.
Exit code is non-zero on any failed assertion.

`drive.ts` is a separate runtime-level driver (real `LocalRuntime` + front
server, no Electron): bundle it with
`npx esbuild e2e/phaseE/drive.ts --bundle --platform=node --format=esm --outfile=<out>/drive.mjs`
and run `node drive.mjs <up|stop|destroy> <root> <id> <apiPort> <uiPort> <uiDir> [pubkeyFile]`.

## What each step asserts

**Step 5, session and Keychain**
- Fresh launch shows the login screen and does not touch the Keychain.
- `safeStorage` encrypts the token; after relaunch the saved session is loaded and the picker appears.
- No storage warning with a working Keychain.

**No-default-Keychain launch/relaunch** (`npm run e2e:phaseE:nokeychain`; separate, needs no JWT and no podman)
- Seeds a throwaway profile with the `safestorage-disabled` flag (and, in a second case, only a stale
  `safestorage-attempt` marker) beside a dummy `session.bin`, then launches the installed app.
- Launched with a throwaway `HOME` that has no Keychain, so any `safeStorage` call would block on the OS
  dialog. Asserts: login screen reached without hanging, no picker (session not decrypted), the disabled flag persists across a relaunch, no attempt marker left behind, and a
  stale attempt marker is converted into the flag. It simulates the app's recorded failure state; it
  does not remove the real default Keychain from the Mac.

**Step 6, local workspaces**
- Creating `e2e-one` serves the UI on `127.0.0.1:9031`; `/api/health` is 200 through the front server.
- Marketplace catalog loads (`/api/apps/-/catalog?refresh=true`, >0 apps).
- The UI only contacts `127.0.0.1` (and Google Fonts).
- A terminal PTY runs `echo PTY_OK_$((6*7))` and returns `PTY_OK_42`.
- Picker shows `1/2`, then `e2e-two` comes up healthy on `9033`, picker shows `2/2`.
- A third create is refused with the free-tier limit dialog and no wizard.

**Step 7, Remove button**
- Remove `e2e-two` through the confirm modal: counter 2/2 -> 1/2, its podman
  machine, containers, network, dirs, registry entry gone, its ports freed, and
  `e2e-one` untouched.

**Step 8, re-create after removal**
- A new workspace comes up healthy and the picker is back to 2/2.

**Teardown and leftovers** (`teardown.mjs`; assertions only with `--teardown`)
- `podman machine rm` succeeded for every run-created workspace (a failure is reported and that workspace's dirs/registry entry are kept so the checks below still see it).
- No podman machines, containers or processes for run-created workspaces.
- Ports 9031-9034 not listening (ports busy before the run are excluded).
- Run-created `~/.awd/local*`, `~/aw-workspaces/local*`, `/tmp/aw-local*` gone.
- Registry (`local-workspaces.json`) has no run-created entries.

## Host guard and hermetic environment

- Before the run the harness records the host's `podman-machine-default` state
  (running/stopped/absent) and the `:9030` health status (read-only: `machine list`
  and one GET). After the run it compares them; any difference is its own
  `host integrity` result and fails the exit code **with or without `--teardown`**.
  Nothing tries to repair a difference. This is a tripwire, not a prevention: it
  tells you the run (or something else) touched the host.
- Every podman call for a run-created workspace gets exactly the four variables
  the app passes (`HOME`, `TMPDIR`, `PATH`, `CONTAINERS_MACHINE_PROVIDER`), with
  the workspace's own HOME/TMPDIR. The caller's environment is not inherited, so
  `XDG_*` / `CONTAINER_*` cannot point a call at the real podman config. The only
  call that uses the real HOME (and keeps `XDG_*`/`CONTAINERS_CONF`, so a host VM defined
  outside `~/.config` is still seen) is the read-only host capture above; if it cannot
  read the host machine state, the host check fails rather than passing blind.
  The Electron app itself is still launched with the caller's environment.

## Known gaps (not fixed by this harness)

1. Teardown still deletes run-created machines, dirs and registry entries
   directly as a safety net; step 7 exercises the real in-app Remove button.
2. **Keychain re-prompt on ad-hoc re-install.** Re-installing an ad-hoc signed
   build changes the code identity, so macOS asks for Keychain access again.
3. **Local Network settings panel stays on "Loading…" in standalone** (a
   local workspace has no host to answer it).

## Recovery drivers (`recovery.mjs`): force quit, hung core, Needs attention + Retry, start failed

`npm run e2e:phaseE:recovery` promotes the failure/recovery scratch drivers into the harness. Same
prerequisites as above (GUI session, installed app, JWT file, no Accessibility permission). It is
**destructive to its own workspace only**: it SIGKILLs that workspace's VM and the app, so it refuses to
start without `AW_E2E_USER_DATA` (a throwaway dir; never the installed app's real profile).

```bash
AW_E2E_JWT_FILE=/path/jwt.txt AW_E2E_USER_DATA=/path/throwaway-ud npm run e2e:phaseE:recovery -- --dry-run   # validate config only
AW_E2E_JWT_FILE=... AW_E2E_USER_DATA=... npm run e2e:phaseE:recovery -- --teardown                            # all scenarios, then clean up
AW_E2E_JWT_FILE=... AW_E2E_USER_DATA=... npm run e2e:phaseE:recovery -- --reuse hung attention               # reuse an existing "e2e-recovery"
```

Extra env: `AW_E2E_WORK` (shim engine copy, mode and call log; default `./.tmp/phaseE-recovery`),
`AW_E2E_ENGINE_SRC` (default `<app>/Contents/Resources/engine`), `AW_E2E_WS_NAME` (default `e2e-recovery`).
Scenarios run in order in one process (`setup` first unless `--reuse`):

| Scenario | Asserts |
|---|---|
| `setup` | seeds the session, creates the fixture workspace through the wizard, healthy |
| `kill` | VM killed with the window open: row "Starting workspace...", same VM disk restarted (`machine start`, no init/rm), health back |
| `hung` | every process in the core container frozen: container restarted, VM process unchanged |
| `attention` | `machine start` failing: exactly 3 automatic attempts, row "Needs attention" + Retry, no 4th attempt, plain copy, diagnostics redacted; **Retry** recovers the same VM |
| `forcequit` | app SIGKILLed with the VM up: relaunch stops the orphan and runs no VM until picked; then **start failed** modal shows plain copy only, Copy details has the raw text with the secret redacted, **Retry** brings it up |

Failure injection: the app is launched with `AW_DESKTOP_ENGINE_DIR` pointing at a **copy** of its bundled
engine whose `podman` is a bash shim (`shim.mjs`): it logs every call to `<work>/calls.log` and, per
`<work>/mode`, fails one subcommand with a `RAWMARK-*` text (and a fake `API_KEY` secret) so the harness can
prove raw output reaches `diagnostics.log`/clipboard but never the UI. The installed bundle is not modified.

Safety: process lookups are scoped to the run's own workspace id (`krunkit.*aw-<id>`) and its own
`--user-data-dir`; podman calls use the hermetic per-workspace env; the host-integrity tripwire
(`podman-machine-default`, `:9030`) runs at start and end; saved text dumps redact token-shaped strings.
Limits: arm64 (libkrun disk path), macOS only; `~/.awd`, `~/aw-workspaces` still derive from `$HOME`.
`kill`/`hung`/`attention`/`forcequit` were promoted from scratch drivers that passed on the Mac; this
committed version has been dry-run and unit-tested only, not yet executed on a device.

## Existing-workspace engine check (`driveExisting.ts`)

Starts an already-registered local workspace with the real `LocalRuntime` and the engine bundled in
a given app copy (`AW_DESKTOP_ENGINE_DIR=<app>/Contents/Resources/engine`), using the workspace's
real `~/.awd` and `~/aw-workspaces`. It never touches the host's own podman machine or `:9030`. Use
it to prove a VM created by an older engine still starts with the bundled one.
