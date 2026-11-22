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
- The bundled podman at `~/podman-dist/podman/bin/podman` (the app's own runtime).
- **A private node**: do not point this at a machine whose podman machines or
  ports 9031-9034 you care about. Teardown deletes `~/.awd/local*`,
  `~/aw-workspaces/local*` and `/tmp/aw-local*`.
- Ports 9031-9034 free, `playwright-core` (`npm ci`, no browser download).
- A test-account JWT in a file (never commit it).

## Environment

| Var | Meaning | Default |
|---|---|---|
| `AW_E2E_JWT_FILE` | **required**, file holding the test-account JWT | none |
| `AW_E2E_APP` | app bundle | `/Applications/AW Desktop.app` |
| `AW_E2E_USER_DATA` | app userData dir | `~/Library/Application Support/aw-desktop` |
| `AW_E2E_PODMAN` | podman binary | `~/podman-dist/podman/bin/podman` |
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
- No `aw-local*` podman machines.
- No `aw-local*` containers/processes.
- Ports 9031-9034 not listening.
- `~/.awd/local*`, `~/aw-workspaces/local*`, `/tmp/aw-local*` gone.
- Registry (`local-workspaces.json`) has no workspaces.

## Known gaps (not fixed by this harness)

1. Teardown still deletes machines, dirs and registry entries directly as a
   safety net; step 7 exercises the real in-app Remove button.
2. **Keychain re-prompt on ad-hoc re-install.** Re-installing an ad-hoc signed
   build changes the code identity, so macOS asks for Keychain access again.
3. **Local Network settings panel stays on "Loading…" in standalone** (a
   local workspace has no host to answer it).
