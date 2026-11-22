# ADR 0001: the Linux VM is required, bundled, managed by the app and invisible

- Status: proposed (design ref `design-4205bf3b-vm-v1`, card `4205bf3b-9510-81fd-a945-c2cc23eb2022`)
- Date: 2026-11-22
- Scope: aw-desktop only. No code in this card.

## Context

Owner decision (Frederico, 2026-11-22): one supported engine, no options, no
no-VM mode on macOS and Windows. The Linux VM stays required, ships with the
app, is run by the app, and the word "podman" never reaches the user.

What the code does today (all on `origin/main` at `c0d4e4b`):

- One VM per local workspace. Each workspace has its own podman `HOME`, its own
  short `TMPDIR` and a named machine `aw-<id>` (`src/main/localRuntime.ts:120`,
  `:139-151`, `:157-166`). The reason is a measured podman limit: one running
  VM per `HOME` (`src/main/localRuntime.ts:5-9`).
- VM size is 2 CPU, 4096 MiB, 40 GiB (`src/main/localRuntime.ts:179-181`). The
  6 CPU / 8 GiB / 100 GiB on the card is podman's own default, which is what
  the unrelated host `podman-machine-default` uses. The app never used it.
- The data the app itself creates sits on the Mac, not in the VM: the data dir
  is shared in by virtiofs and bind-mounted (`src/main/localRuntime.ts:184`,
  `:194`, `:203`, `:246-247`). That is not the same as "the VM holds nothing":
  the core also gets the VM's engine socket (`:248`), so an app can create a
  named volume or keep state in a container layer, and both live on the VM
  disk.
- The engine is not bundled. It is downloaded from GitHub after a user click,
  into `~/podman-dist/podman` (`src/main/dependencies.ts:7-14`,
  `src/main/depsRuntime.ts:46-72`). That path is shared with aw-remote-host's
  own bootstrap (`src/main/runtimeProbe.ts:26-27`). The installer removes the
  `~/podman-dist/podman` subdirectory before copying the new one in, and
  rewrites `~/podman-dist/env.sh` (`src/main/depsRuntime.ts:59-67`). It does
  not remove the parent `~/podman-dist`.
- Health is checked once, at start (`src/main/localRuntime.ts:461-463`).
  "Running" is an in-memory set that is never re-validated
  (`src/main/localWorkspaces.ts:63`, `:77-83`). A crashed VM keeps a "running"
  row and a dead window.
- Quit stops every VM (`src/main/index.ts:471-478`). A force quit, crash or
  reboot leaves VMs running with no owner; on relaunch the set is empty, so
  those rows read "Not running" while the VM still holds its RAM.
- Cap of 2 per account, client side (`src/main/localRegistry.ts:12`,
  `:209-214`; limit fetched at `src/main/index.ts:39-42`).

## Decision 1: keep one VM per workspace

Recommendation: **stay on one VM per workspace**. This goes against the current
lean, so the reason comes first.

A shared VM means one container engine for every local workspace, and the
workspace core assumes it owns its engine:

- Tier-2 app containers get engine-wide fixed names, `aw-app-<app_id>`
  (aw-workspace `src/apps/containers.py:521`) and sidecars
  `aw-app-<app_id>-<name>` (`:811`). The same name is handed to apps as their
  own address (`:1062-1064`) and returned by `src/apps/base.py:556`. Two
  workspaces installing the same app on one engine would take each other's
  container.
- The core is given the whole engine socket (`src/main/localRuntime.ts:248`,
  `AW_CONTAINER_SOCKET` at `:230`). Apps that hold it create their own
  containers too (aw-app-agents-platform-runners `execute.py:1318`, `:4028`,
  `:4219`, `warm_pool.py:736`). On a shared engine, workspace A can see, stop
  and remove workspace B's containers.

So a shared VM is not an aw-desktop change. It needs a contract change in the
core plus an audit of every app that takes the engine socket. The previous
design on card 41f5bf3b (`design-41f5bf3b-v1`) rejected a shared VM for the
same reason; nothing in the core has changed since.

What a shared VM would actually buy, measured against the real numbers:

| | Per workspace (today) | Shared |
|---|---|---|
| RAM ceiling at the cap of 2 | 2 x 4 GiB | one VM, which would need about 6 GiB for two workspaces |
| Disk | 2 x 40 GiB sparse, images pulled twice | one disk, images pulled once |
| Second workspace start | full VM boot again | no VM boot |
| Remove | delete the VM and three dirs (`src/main/localRuntime.ts:500-522`) | per-container, per-network, per-image cleanup inside a VM that stays |
| Failure blast radius | one workspace | every workspace |
| Socket path limit | one path per id, pinned by a test (`test/localWorkspaces.test.ts:40-45`) | one fixed path |

The saving is real but smaller than the card assumed (roughly 2 GiB of RAM and
one image set at the cap), and the cap of 2 already bounds the cost.

What would change this call: a working spike of the runner-up (below), or the
Product Owner accepting the core and apps contract change as scope.

## Decision 2: bundle the engine in the app

- Ship the engine binaries inside the app bundle as `extraResources`, next to
  the UI build (`electron-builder.yml:9-14`). Fetch them at release time with a
  pinned sha256, the same shape as `scripts/fetch-ui.sh` and the existing pin
  (`src/main/dependencies.ts:8-10`). Keep the same engine version (6.0.2) so
  existing VMs see no version change.
- `podmanBinPath` (`src/main/localWorkspaces.ts:37`) and the helper `PATH`
  (`:49`) resolve from `process.resourcesPath`, like `uiStaticDir` (`:55-57`).
- The app stops reading and writing `~/podman-dist`. It never deletes it: on a
  Mac that also runs aw-remote-host that directory belongs to the live
  workspace.
- The VM OS image and the three container images are still downloaded on first
  create. Pin the VM OS image so every install boots the same one.
- Intel Macs stay unsupported (`src/main/dependencies.ts:6`, `:52`).

## Decision 3: the app owns the lifecycle

- No Dependencies step. `src/renderer/screens/Dependencies.tsx`,
  `src/main/dependencies.ts`, `src/main/depsRuntime.ts`,
  `src/main/runtimeProbe.ts`, the `aw:checkRuntime` and `aw:deps*` handlers
  (`src/main/index.ts:320-333`) and "Step 1 of 2"
  (`src/renderer/screens/Picker.tsx:433-459`) go away. A silent preflight
  replaces them: chip architecture, virtualization support, free disk, total
  RAM, and the socket path length for this username.
- Status model grows from running/stopped (`src/main/localWorkspaces.ts:33`) to
  stopped, starting, running, needs attention.
- A supervisor in the main process polls `/api/health` on each running
  workspace's API port. On failure the row and window show "Starting
  workspace..." and the app re-runs `LocalRuntime.start`, which is already
  idempotent (`src/main/localRuntime.ts:412-465`). It runs inside the existing
  setup slot (`src/main/index.ts:35`) so it cannot race Remove. Three attempts,
  then "needs attention" with a Retry button.
- Recovery must restart a stuck service, not only wait for it. Today `start`
  leaves a container alone when the engine reports it running and its port is
  unchanged (`src/main/localRuntime.ts:381-387`, `:468-478`), then waits on the
  same health URL (`:461-463`). A hung core would time out three times
  untouched. The recovery path therefore needs its own rule: when the VM and
  the container are running but health fails, restart the workspace container
  before waiting again. A normal start keeps today's behaviour. The existing
  timeout test (`test/localRuntime.test.ts:202`) only checks that start
  rejects; this case needs a test that the container is restarted and health
  then passes.
- Self-heal never removes or re-creates a VM. Removing a VM deletes its disk,
  and with it any named volume or container state an app created through the
  engine socket. If the VM cannot be started after the retries, the workspace
  goes to "needs attention" and stays there.
- Re-creating a VM is a separate, user-confirmed action. An empty volume list
  and no extra containers are necessary but not sufficient: state can also sit
  in a container's writable layer, which dies with the VM. The action is
  allowed only when every check below passes, all read-only, all against a
  running engine. Any check that fails, errors, or cannot be run refuses the
  action (fail closed). A VM that is not running cannot be asked, so it is
  always refused.
  1. The engine lists zero named volumes (`podman volume ls`).
  2. The engine lists exactly the three containers the app creates
     (`containerNames`, `src/main/localRuntime.ts:122`: postgres, redis,
     workspace) and no others. Each must carry a label naming this workspace
     id. The label is new: card 6 adds it to the three `run` argument builders
     (`:188-205`, `:240`). A container without it, which includes every
     container made by an earlier build, is unproven and refuses the action
     until it is recreated by a build that sets the label.
  3. Each of the three has only the mounts the app gave it. `podman inspect`
     shows no anonymous or named volume, and the only bind sources are the
     workspace data dirs and the engine socket (`:184-186`, `:242-246`). This
     is what proves postgres, redis and the core keep their data on the Mac.
  4. Each container's writable layer holds nothing beyond an allowlist.
     `podman diff <container>` is read for each; any changed path outside the
     allowlist refuses. The allowlist (temp and cache paths per image) is
     defined from a measured run in card 6, not guessed here. Until card 6
     lands that allowlist, the answer is "unproven", so the action stays
     refused.
  5. The checks run in one pass immediately before the confirmation, and
     again after the user confirms. Before the first pass the app quiesces the
     workspace with a new operation that stops only the three containers
     (`podman stop`) and leaves the VM and its engine running. The existing
     workspace stop path cannot be used: it also stops the VM
     (`src/main/localRuntime.ts:484-489`), after which the engine cannot be
     asked and the guard would refuse every workspace. The container
     inventory in checks 2 and 4 lists all states (`podman ps -a`), so a
     stopped or exited extra container still counts. If the inventory changed
     between the two passes, refuse.
  6. The removal itself is a new VM-only operation, not the existing Remove
     path. Remove deletes the workspace data dirs and unregisters the
     workspace (`src/main/localRuntime.ts:500-549`,
     `src/main/localWorkspaces.ts:106`), which would destroy exactly the data
     checks 1 to 4 say is safe. The VM-only operation removes the machine and
     its machine config dirs under the workspace's podman `HOME` and nothing
     else: the registry entry, the data dir and the workspace dir stay. It
     then creates a fresh VM and restarts the workspace. Its successful-path
     test seeds representative files in the Postgres, Redis and workspace
     bind-mount dirs and asserts, after the re-create, that the files are
     byte-identical and the registry entry is unchanged.

  The guard does not outlive the VM it describes. Removing the VM discards the
  evidence, so the proof is taken from the live VM that is about to be
  removed, never from a stored result or an earlier session. A backup and restore path for engine volumes is not designed
  here; until one exists, a VM that holds volumes and will not start is a
  support case, not something the app repairs.
- Launch: for every registry entry, stop any VM left running by a previous
  session. Workspaces start when picked (`src/main/index.ts:295-303`).
- Quit: unchanged, stop all. No login item, no background agent.
- Wake from sleep: run the health check from the existing resume hook
  (`src/main/index.ts:466`).
- Sizing: keep 2 CPU / 4 GiB / 40 GiB as the default in `RuntimeConfig.machine`
  (`src/main/localRuntime.ts:107`). Proposed guards, for the Product Owner to
  confirm: refuse to start a second workspace on a Mac with less than 16 GiB of
  RAM, refuse to create with less than 15 GiB of free disk.
- Disk growth: the VM disk grows and does not shrink. Prune unused images after
  an image pin bump. "Free up space" prunes unused images only; it never prunes
  volumes and never re-creates the VM.

## Decision 4: no engine wording reaches the user

Strings to replace: `src/shared/bootstrapState.ts:8-9`,
`src/renderer/screens/Picker.tsx:149` and `:303`,
`src/renderer/screens/Dependencies.tsx:41-47` (deleted with the screen),
`src/main/dependencies.ts:57-66` (same).

The leak that matters most is errors. `PodmanCommandError` puts the raw command
and stderr in its message (`src/main/localRuntime.ts:50`), and that message is
sent to the renderer as is (`src/main/index.ts:222`,
`src/shared/bootstrapState.ts:38-40`). Add a classifier in the main process
that maps failures to a small set of codes with plain copy:

| Code | What the user reads |
|---|---|
| `virtualization_unavailable` | This Mac can't run local workspaces. |
| `low_disk` | Not enough free disk space. Free up N GB and try again. |
| `low_memory` | Not enough memory to start another workspace. Close one first. |
| `download_failed` | Couldn't download the workspace. Check your connection. |
| `start_failed` | The workspace couldn't start. Retry, or copy details for support. |

Raw detail goes to a log file under userData, behind a "Copy details" button.
Progress steps collapse to "Preparing your workspace" and "Starting workspace";
the internal step ids (`src/shared/types.ts:125`) stay. A test in the shape of
`test/noEmDash.test.ts` fails the build when renderer or shared copy contains
podman, VM, container or image.

Not hidden, and accepted: helper process names in Activity Monitor, and the
`~/.awd` and `~/aw-workspaces` folders.

## Decision 5: other platforms

Split `LocalRuntime` along the line it already has: VM lifecycle
(`src/main/localRuntime.ts:328-353`) versus container work (`:355-479`). The VM
half becomes an engine-host interface with one implementation per platform.

- Windows: the same per-workspace model on the WSL2 backend. Each machine is a
  WSL distro and all distros share one utility VM, so per-workspace costs less
  there than on macOS. Two open problems need their own design card: enabling
  WSL needs admin rights and a reboot, so it cannot be invisible; and bind
  mounts from the Windows filesystem are too slow for Postgres, so data has to
  live inside the distro, which changes Remove and backup.
- Linux: no VM. One rootless engine instance per workspace, each with its own
  storage root and socket, so the "one workspace, one engine" rule still holds.
  Not verified.

## Decision 6: migration

None for VM topology, because it does not change. The one migration is the
engine path: existing VMs were created by `~/podman-dist` binaries and must
start with the bundled ones. Same version, so this should be a no-op; it has to
be proven on a Mac that already has workspaces.

## Decision 7: test guard

- Host state capture is new. Today `snapshot()`
  (`e2e/phaseE/teardown.mjs:33-36`) records only the registry ids and which of
  the test ports 9031-9034 were already listening; it records nothing about
  the host's `podman-machine-default` or `:9030`. Card 1 adds a capture of the
  host's `podman-machine-default` running state and the `:9030` health status
  before the run, and a host-integrity check that asserts both are unchanged
  after it. Read-only commands only. A change fails the run with its own message and nothing tries to repair
  it.
- The host check must fail the run in every mode. It cannot simply join
  `leftovers()` (`e2e/phaseE/teardown.mjs:93-111`), because the runner records
  every leftovers result as a pass unless `--teardown` is set
  (`e2e/phaseE/run.mjs:157-158`). Keep it as its own result, recorded with its
  real outcome and counted in the exit status (`e2e/phaseE/run.mjs:161`) with
  or without `--teardown`.
- Make the harness hermetic. The app passes podman exactly four variables
  (`src/main/localRuntime.ts:157-166`, pinned by `test/localRuntime.test.ts:76`).
  The harness does not: it spreads the caller's whole environment into every
  podman call (`e2e/phaseE/teardown.mjs:16`). Inherited `XDG_*` or
  `CONTAINER_*` variables can point those calls at the user's real podman
  config. This is a lead for the 2026-11-22 incident, not a proven cause.

## Rejected

- **Shared VM, one flat engine.** Needs a workspace prefix on every container
  name in the core, network aliases to keep the `aw-app-*` hostnames apps embed
  (`src/apps/containers.py:67-68`), and the same audit in every app that holds
  the socket. Cross-repo, ships to every deployment, and still leaves
  workspaces able to control each other's containers.
- **Shared VM, one nested engine per workspace (runner-up).** Each workspace
  runs in an outer container with its own engine, so the core contract holds.
  Not proven on this VM type, needs a privileged outer container, and images
  are stored per workspace again, which removes the disk saving. Worth a
  time-boxed spike only if shared is still wanted.
- **Engine in the DMG plus the VM OS image.** Makes every app update re-ship a
  large file that changes rarely.
- **Keep the download-on-click installer.** It is the "options" surface the
  owner decision removes, and it shares a directory with another product.

## What this makes harder later

- The cap cannot rise much: every extra workspace is another 4 GiB VM.
- Workspaces only run while the app runs, so scheduled work inside a local
  workspace stops at quit.
- An engine upgrade now needs an app release, and old VMs must keep working
  with the new binaries.
- A VM that will not start and holds app volumes has no in-app repair. That
  stays true until someone designs backup and restore for engine volumes.
- Windows will not share the macOS data layout.

## Risks for the Coders

- Signing. electron-builder re-signs every binary in the bundle with one
  entitlements file (`electron-builder.yml:27-28`), and that file has no
  hypervisor entitlement (`build/entitlements.mac.plist`). The VM helpers need
  it. An unsigned dev build will pass and the notarized build will fail to
  boot a VM. Verify on the signed build only.
- "Running" is tracked in memory in two places (`src/main/localWorkspaces.ts:63`
  and the port-conflict check at `:87-94`). The supervisor must be the single
  writer or the port reconcile will misjudge its own ports.
- Launch cleanup must only touch machines named for ids in the registry, under
  their own `HOME`. The unit tests cannot catch a call that reaches the real
  `HOME`; the phaseE guard can.
- The error classifier will be matched against stderr text that changes between
  engine versions. Unknown text must fall to `start_failed`, never to a
  specific wrong message.
- Long macOS usernames can still exceed the socket path limit. The test pins
  one username length only.

## Implementation cards

Sizes: S is under a day, M is one to two days, L is three or more.

| # | Card | Size | Depends on |
|---|---|---|---|
| 1 | phaseE host guard and hermetic harness environment | S | none, do first |
| 2 | Bundle the engine in the app: release fetch with pinned checksum, resource path, signing and entitlements, pinned VM OS image, existing VMs still start | L | 1 |
| 3 | Remove the Dependencies step, add the silent preflight | M | 2 |
| 4 | Plain-language copy, error classifier, diagnostics log, wording test | M | none |
| 5 | Lifecycle supervisor: status model, health polling, self-heal, launch cleanup, wake check | L | 4 |
| 6 | Sizing guards, image pruning, "Free up space" (images only), guarded user-confirmed VM re-create | S | 5 |
| 7 | Engine-host interface split (refactor, no behaviour change) | M | 5 |
| 8 | Windows design (new Architect card) | M | 7 |
| 9 | Optional spike: shared VM with a nested engine per workspace | S | only if shared is still wanted |

Acceptance checks for the set:

- A new user on a clean Apple Silicon Mac creates a local workspace without
  ever seeing an install step or an engine name.
- Killing the VM process while a workspace window is open shows "Starting
  workspace..." and recovers without user action.
- Force-quitting the app and relaunching leaves no VM running until a workspace
  is picked.
- A full phaseE run leaves `podman-machine-default` and `:9030` exactly as they
  were, and exits non-zero if not, with or without `--teardown`.
- A workspace whose core hangs while its container still reports running is
  restarted by recovery and becomes healthy again.
- No automatic path removes a VM. Re-create is refused when the engine lists a
  named volume or cannot be asked.

Acceptance per card. Each is a pass/fail check a reviewer can run on the merged
change.

- Card 1 (phaseE guard): simulate a host VM that is running in the before
  snapshot and stopped in the after snapshot. The run exits non-zero with a
  host-integrity message, with and without `--teardown`. A run with identical
  before and after host state passes, including when the host VM is stopped
  throughout. The harness env test asserts podman is called with only the
  four variables the app uses.
- Card 2 (bundle): the signed, notarized build boots a VM on a clean Mac with
  no `~/podman-dist`. A Mac with existing per-workspace VMs starts them with
  the bundled binaries and the same engine version. `~/podman-dist` is
  untouched afterwards (checksum of the directory listing).
- Card 3 (preflight): no Dependencies step renders. With virtualization
  unavailable, low RAM or low disk, the user sees the plain message from card
  4 and no VM is attempted.
- Card 4 (copy): a wording test fails if any user-facing string contains
  "podman" or a raw VM name. Unknown stderr maps to `start_failed`, never to a
  specific wrong message. Raw stderr goes to the diagnostics log only.
- Card 5 (supervisor): the three recovery scenarios in the set-level checks
  pass, and Remove during recovery does not race it.
- Card 6 (guards, prune, re-create): the re-create checks 1 to 5 above each
  have a test where that check alone fails and the action is refused. The
  VM-only removal (6) has the data-survival test described there. "Free up
  space" removes images only; a test with a named volume present shows the
  volume survives. The `podman diff` allowlist is written down from a
  measured run.
- Card 7 (engine-host split): no behaviour change. The existing test suite
  passes unchanged, and a diff of the `podman` argument lists the macOS path
  produces, before and after, is identical.
- Card 8 (Windows design): delivers an ADR section, not code. It must state
  the WSL2 mapping of Decisions 1-7, name what has no equivalent, and list
  the checks that could not be run without a Windows host. The owner accepts
  it before any Windows implementation card exists.
- Card 9 (spike, only if shared is still wanted): answers one question with a
  measurement. Can two nested engines in one VM run `aw-app-*` containers of
  the same names without collision? Reports yes or no with the commands run.
  Produces no code to merge.

Gate: the owner decision on one VM per workspace versus shared is still open.
No implementation card (1 to 9) is created or dispatched until the owner
answers it on the card.
