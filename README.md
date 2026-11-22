# aw-desktop

Native macOS shell for **aw-workspace** — a signed, notarized, auto-updating
Electron thin client. Its main window is a Chromium `BrowserWindow` loading
the hosted workspace UI **unmodified**, at `https://<slug>.workspace.<apex>`.
There is no custom dashboard: native (local) screens exist only for splash,
login/signup, and the workspace picker.

Design doc: Kanban card `4175bf3b-9510-8104-8c21-f5008b4d708b`
("Productize AW Workspace: Mac installer Phase 1 — architecture/build
plan"). This repo implements that design; read the card before changing the
shape of auth, session handoff, or the window model.

## Architecture

- `src/main/` — main process: window lifecycle (`windows.ts`), the
  aw-backend identity client (`apiClient.ts`), encrypted session storage via
  Electron `safeStorage` (`authStore.ts`), cookie injection into the shell
  window's session (`cookie.ts`), the Google SSO custom-scheme handoff
  (`oauth.ts`), and `electron-updater` wiring (`updater.ts`).
- `src/preload/` — exposes a minimal `window.aw` bridge
  (`src/shared/types.ts#AwBridge`) to the **auth window only**. It is never
  attached to the shell window that renders the real workspace UI.
- `src/renderer/` — the local screens (splash, login/signup/forgot-password,
  workspace picker), Vite + React + TS. Visual identity ("Signal Amber",
  Inter, the "❯ aw" wordmark) is reused from the UX-Proto click-through at
  project `aw-desktop-app` (card `4175bf3b-9510-81a8-9917-dce61a9ff908`), not
  invented here.

### Auth flow

Login/signup/forgot-password run entirely in the **main process**, not the
renderer — a renderer-origin `fetch()` silently drops the backend's
`SameSite=Lax` cookie, which is exactly the native-app auth bug this design
calls out. The main process:

1. Calls `aw-backend`'s existing identity endpoints directly
   (`/api/identity/login`, `/api/signup`, `/api/identity/refresh`,
   `/api/identity/me`, `/api/identity/email-code/{start,verify}`).
2. Persists the returned JWT via `safeStorage` (Keychain-backed).
3. Injects it as the `aw_id_jwt` cookie into the shell window's session,
   matching `_issue_identity_cookie`/`_cookie_domain_for` in aw-backend
   attribute-for-attribute, so the workspace SPA's own
   `/api/auth/status` gate passes with zero UI changes.
4. Google SSO opens the **system browser** (Google rejects embedded
   webviews) on `/api/identity/google/start?client=mac`, and receives the
   one-time code back on the `awdesktop://auth` custom scheme — see
   "Backend dependency" below.
5. Forgot-password reuses the same passwordless email-code login console
   already has — there is no separate password-reset flow (Frederico's
   2026-11-13 decision on the design card).

### Backend dependency — NATIVE_CLIENTS

The Google SSO handoff needs exactly one change on `aw-backend`:
`"mac": "awdesktop://auth"` added to `NATIVE_CLIENTS` in
`src/api/native_oauth_handoff.py`. Shipped alongside this scaffold as a
separate PR against `fredericowu/aw-backend` (that repo is PR-first); until
it merges, the Google SSO button will open the browser but the sign-in
sheet will never come back (a wrong/missing scheme doesn't error — see that
file's own warning).

## Running locally (unsigned)

```bash
npm install
npm run dev
```

Points at `https://api.aw.tekflox.com` and `*.workspace.aw.tekflox.com` by
default. Override with:

```bash
AW_DESKTOP_APEX=your-dev-apex.example.com npm run dev
```

## Building a local, unsigned package

```bash
npm run dist
```

Produces an **unsigned** `.app`/`.dmg` under `dist/` — fine for local
testing, not for distribution (macOS Gatekeeper will refuse an unsigned,
unnotarized app on another machine).

## Bundling the workspace UI

`npm run dist` / the release workflow bundle the workspace UI via
`scripts/fetch-ui.sh`, which fetches the **public**
`fredericowu/aw-workspace-ui` anonymously (no token, no secret) at the **pinned
full commit SHA in `scripts/ui-ref`** (the script fails if it is missing or
malformed), so a tag determines the bundled UI. Bump the ref with a PR when the
desktop needs a newer UI. The script also writes `build-info.json` into the
packaged resources (desktop commit, tag, UI commit, workflow run id). Set
`AW_UI_SRC=/path/to/aw-workspace-ui` to reuse a local checkout (skips the pin), or
`AW_UI_REPO_TOKEN` only if you point it at a private fork.

## E2E harness (packaged app, macOS)

`e2e/run.mjs` drives the real packaged `AW Desktop.app` through Playwright
`_electron` against `e2e/mock-backend.mjs`. Its only extra dependency,
`playwright-core`, is a devDependency, so a clean `npm ci` is enough
(no browser download needed, Electron is driven directly):

```bash
npm ci && npm run dist
node e2e/mock-backend.mjs <port> <cert.pem> <key.pem> <work>/mock.jsonl &
NODE_TLS_REJECT_UNAUTHORIZED=0 node e2e/run.mjs "dist/mac-arm64/AW Desktop.app" <work> <port>
```

## What's missing for a first signed release

None of these secrets exist yet on `fredericowu/aw-desktop` — `.github/workflows/release.yml`
is wired to expect them but does not block on their absence (an unsigned
build + artifact upload still runs without them):

| Secret | Purpose |
|---|---|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Base64-encoded **Developer ID Application** `.p12` cert + its password — the actual code-signing identity. Not Apple Distribution (that's for the Mac App Store / TestFlight, which this app is not). |
| `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_CONTENT_B64` | App Store Connect API key for `notarytool` — same credential **shape** as `aw-meta-glasses-2`'s fastlane notarization, different tool (`@electron/notarize` via `notarytool`, see `build/notarize.js`). |
| `APPLE_TEAM_ID` | The Apple Developer Team ID the cert above belongs to. |

Once those are set as GitHub Actions secrets on this repo, pushing a `v*`
tag (or a manual `workflow_dispatch`) builds, signs, notarizes, and
publishes a GitHub Release that `electron-updater` consumes.

## Releasing (macOS + Windows)

`.github/workflows/release.yml` ("Desktop Release") builds and publishes
both platforms to one GitHub Release per tag:

1. Bump `version` in `package.json` to `X.Y.Z`.
2. Commit that bump.
3. Tag the commit `vX.Y.Z` (the leading `v` is required — the workflow
   triggers on `push: tags: v*`) and push the tag:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. The tag push fires both jobs: `release-macos` (macOS 15 runner, dmg +
   zip) then `release-windows` (windows-latest runner, nsis installer),
   serialized so they don't race creating the same Release. Each publishes
   to the GitHub Release for that tag as a **prerelease** (not Latest, so
   the auto-updater does not offer it yet).
5. `workflow_dispatch` re-runs the same thing manually against whatever
   tag/ref you pick, useful for retrying a failed publish without a new
   version.

The tag and `package.json`'s `version` must always move together — the
workflow does not read or enforce the version itself (electron-builder
takes it from `package.json`), so a tag that doesn't match `package.json`
will still build and publish, just under a misleading Release name/file
version. Never reuse a tag; cut a new patch version instead.

### Promoting a release (explicit, manual)

Releases are created as prereleases. Verify the signed build on a Mac
(asset SHA-256 vs GitHub digest and `latest-mac.yml`, `stapler validate`,
`spctl`, Team ID, installed `build-info.json`, signed-to-signed upgrade with no
Keychain prompt), then promote:

```bash
gh release edit vX.Y.Z --prerelease=false --latest
```

Rollback: `gh release edit vPREV --latest` and
`gh release edit vX.Y.Z --prerelease`. This stops the updater offering vX.Y.Z;
never delete or replace assets. Clients already on vX.Y.Z are not downgraded;
ship a forward fix.

**Signing status:** until Apple (`CSC_LINK`/`CSC_KEY_PASSWORD`,
`ASC_KEY_ID`/`ASC_ISSUER_ID`/`ASC_KEY_CONTENT_B64`/`APPLE_TEAM_ID`) and
Windows code-signing secrets exist on this repo, every release is
unsigned: macOS shows a Gatekeeper "unidentified developer" warning
(right-click → Open bypasses it), Windows shows a SmartScreen warning
("More info" → "Run anyway" bypasses it). Both are expected and should be
called out plainly in the Release notes, not hidden.

## Out of scope (Phase 1)

Linux builds, usage metering/billing (a separate Target, graduates
later), Mac App Store distribution, offline mode, multi-account
switching, native workspace-creation UI (delegated to the embedded
console page), code-signing/notarization itself (blocked on real
credentials), electron-updater's actual auto-update behavior (not yet
exercised end to end).
