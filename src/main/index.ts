import { join } from "node:path";
import { app, clipboard, ipcMain, powerMonitor, BrowserWindow, Menu } from "electron";
import { APEX, CONSOLE_BASE, workspaceUrl } from "./config";
import * as api from "./apiClient";
import { ApiError } from "./apiClient";
import { loadToken, saveToken, clearToken } from "./authStore";
import { injectIdentityCookie, clearIdentityCookie, injectLocalIdentityCookie, clearLocalIdentityCookies, revokeAllLocalAppTokens } from "./cookie";
import { registerProtocolHandler, startGoogleSignInHandoff } from "./oauth";
import { createAuthWindow, createShellWindow } from "./windows";
import { checkForUpdates, installPendingUpdate, UPDATE_RECHECK_MS, INSTALL_QUIT_GRACE_MS } from "./updater";
import { guardedOpen, persistSessionSafely } from "./safeOpen";
import { preflight } from "./preflight";
import { classifyError, looksLikeEngineText, type ClassifiedError } from "./errorClassifier";
import { appendDiagnostic, readDiagnosticTail } from "./diagnostics";
import { platformFor } from "./enginePlatform";
import { PodmanCommandError, UpgradeFailedError, WORKSPACE_IMAGE, pinnedImage, upgradeAvailable } from "./localRuntime";
import { WINDOWS_VM, hostFacts, vmFactsFromInspect, type VmFacts } from "./aboutFacts";
import { readFileSync } from "node:fs";
import { LocalWorkspaces, cachedIdentityPublicKey, identityPublicKey } from "./localWorkspaces";
import { createBannerView } from "./bannerView";
import { RecoveryBanner } from "./recoveryBanner";
import { LocalLimitReachedError } from "./localRegistry";
import { openIfCurrent, SessionScope, type SessionHandle, SetupSlot, scopedExclusive } from "./localBootstrap";
import { advance, complete, fail, startProgress } from "../shared/bootstrapState";
import { UPGRADE_COPY } from "../shared/errorCopy";
import { LOCAL_PLACEMENT } from "../shared/workspaces";
import type { AccountInfo, ApiResult, AuthState, AwUser, BootstrapProgress, WorkspaceInfo, WorkspaceListData } from "../shared/types";

// macOS only (Phase 1, per Architect design) — a second instance just
// focuses the first rather than opening twice, which also keeps a single
// process around to receive the `open-url` OAuth callback.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
// Windows (and Linux) deliver an `awdesktop://` callback as argv of a SECOND instance, which exits at the lock above.
// This is the first instance receiving it: oauth.ts hands the code to the waiting Google sign-in, and we bring the
// window the user is looking for to the front.
app.on("second-instance", () => {
  const w = shellWindow && !shellWindow.isDestroyed() ? shellWindow : authWindow && !authWindow.isDestroyed() ? authWindow : null;
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let authWindow: BrowserWindow | null = null;
let shellWindow: BrowserWindow | null = null;
/** Recovery banner inside the open local workspace window (null for cloud workspaces / no window). */
let recoveryBanner: RecoveryBanner | null = null;
let bannerDispose: (() => void) | null = null;
let bannerContentsId: number | null = null;
let currentToken: string | null = null;

let bootstrapProgress: BootstrapProgress | null = null;
const setupSlot = new SetupSlot();
/** A setup job belongs to the sign-in session that started it. */
const sessionScope = new SessionScope();

const local = new LocalWorkspaces(
  () => currentToken,
  async (t) => (await api.accountMe(t)).limits?.max_local_workspaces,
);
/** Loopback UI port of the open local workspace window, if any (cookie refresh + cleanup). */
let shellLocalPort: number | null = null;
/** Account key for the per-account cap: the identity user id. */
const currentSub = (): string => String(state.user?.id ?? "");

/** Workspace id whose About-initiated upgrade dialog the Picker has not yet claimed. */
let pendingUpgrade: string | null = null;
let state: AuthState = { stage: "splash", user: null, error: null, apex: APEX, openError: null, storageWarning: null };

/** macOS keeps the app alive after the picker window is closed, leaving
 * `authWindow` pointing at a destroyed window: every send/hide must go through this. */
function liveAuthWindow(): BrowserWindow | null {
  return authWindow && !authWindow.isDestroyed() ? authWindow : null;
}

function setState(partial: Partial<AuthState>): void {
  state = { ...state, ...partial };
  liveAuthWindow()?.webContents.send("aw:state-changed", state);
}

function teardownToLogin(error: string | null = null): void {
  currentToken = null;
  // End the initiating session's setup job: no more progress, token use or auto-open.
  sessionScope.end();
  bootstrapProgress = null;
  clearToken();
  clearIdentityCookie().catch(() => undefined);
  clearLocalCookies();
  shellWindow?.close();
  shellWindow = null;
  if (!authWindow || authWindow.isDestroyed()) authWindow = createAuthWindow();
  authWindow.show();
  setState({ stage: "login", user: null, error });
}

/** Every authenticated user lands on the Local/Cloud picker — with 0, 1 or
 * N memberships. The picker is where the guided local create lives, so a
 * single membership no longer skips it. */
function clearLocalCookies(): void {
  const ports = local.registry.list().map((w) => w.uiPort);
  shellLocalPort = null;
  revokeAllLocalAppTokens();
  void clearLocalIdentityCookies(ports).catch(() => undefined);
}

function routeAfterAuth(user: AwUser): void {
  setState({ stage: "picker", user, error: null });
}

async function openWorkspace(slug: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!currentToken) {
    teardownToLogin("session_lost");
    return false;
  }
  const token = currentToken;
  const localWs = local.registry.get(slug);
  if (localWs && localWs.sub !== currentSub()) return false;
  setState({ stage: "loading-workspace", error: null, openError: null });
  return guardedOpen(
    slug,
    () =>
      openIfCurrent(
        isCurrent,
        () => (localWs ? injectLocalIdentityCookie(token, localWs.uiPort) : injectIdentityCookie(token)),
        () => {
          liveAuthWindow()?.hide();
          shellLocalPort = localWs ? localWs.uiPort : null;
          shellWindow = localWs
            ? createShellWindow(`http://127.0.0.1:${localWs.uiPort}/`, `http://127.0.0.1:${localWs.uiPort}`)
            : createShellWindow(workspaceUrl(slug));
          watchForSessionExpiry(shellWindow);
          attachRecoveryBanner(shellWindow, localWs ? localWs.id : null);
        },
        // Signed out while the cookie was being written: don't leave it behind.
        () => (localWs ? clearLocalCookies() : void clearIdentityCookie().catch(() => undefined)),
      ),
    // A cookie/window failure must not strand the picker on "Opening your workspace...".
    (openError) => {
      if (!isCurrent() || !currentToken) return;
      liveAuthWindow()?.show();
      setState({ stage: "picker", openError });
    },
  );
}

/** The SPA drops to unauthenticated and navigates to its own console login
 * URL on an expired/invalid session (rechecked on window focus — the
 * 2026-07-29 logout fix) — catch that navigation, not just a periodic
 * /me poll, since a poll can miss the window between checks. */
function watchForSessionExpiry(win: BrowserWindow): void {
  win.webContents.on("did-navigate", (_event, url) => {
    if (url.startsWith(`${CONSOLE_BASE}/login`)) {
      teardownToLogin("session_expired");
    }
  });
  win.on("closed", () => {
    if (shellWindow === win) {
      shellWindow = null;
      detachRecoveryBanner();
    }
  });
}

function detachRecoveryBanner(): void {
  recoveryBanner?.setOpen(null);
  bannerDispose?.();
  recoveryBanner = null;
  bannerDispose = null;
  bannerContentsId = null;
}

/** Local workspaces only: show supervisor recovery inside the workspace window (picker is hidden then). */
function attachRecoveryBanner(win: BrowserWindow, localId: string | null): void {
  detachRecoveryBanner();
  if (!localId) return;
  const view = createBannerView(win);
  bannerDispose = view.dispose;
  bannerContentsId = view.webContentsId();
  recoveryBanner = new RecoveryBanner({
    view,
    statusOf: (id) => local.supervisedStatus(id),
    retry: retryRecovery,
  });
  recoveryBanner.setOpen(localId);
}

/** Banner Retry: a recovery-mode start inside the setup slot. Keeps the VM and its disk; never opens a second window. */
async function retryRecovery(id: string): Promise<boolean> {
  if (!setupSlot.claim()) return false;
  const initiator = shellWindow;
  try {
    if (!local.registry.get(id) || !currentToken) return false;
    const ok = await local.retry(id, async () => cachedIdentityPublicKey() ?? (await identityPublicKey()));
    // Reload only the window that asked, and only if it is still the open one.
    if (ok && initiator && shellWindow === initiator && !initiator.isDestroyed()) initiator.webContents.reload();
    return ok;
  } catch (err) {
    void logFailure("banner_retry", err);
    return false;
  } finally {
    if (local.registry.get(id)) liveAuthWindow()?.webContents.send("aw:workspace-status", local_row(id));
    setupSlot.release();
  }
}

async function bootstrap(): Promise<void> {
  authWindow = createAuthWindow();
  setState({ stage: "splash", error: null });

  const token = loadToken();
  if (!token) {
    setState({ stage: "login" });
    return;
  }

  currentToken = token;
  try {
    const user = await api.me(token);
    setState({ user });
    routeAfterAuth(user);
  } catch {
    currentToken = null;
    clearToken();
    setState({ stage: "login", error: null });
  }
}

async function refreshLoop(): Promise<void> {
  if (!currentToken) return;
  try {
    const { token, user } = await api.refresh(currentToken);
    currentToken = token;
    persistSessionSafely(() => saveToken(token));
    if (shellWindow) {
      if (shellLocalPort) await injectLocalIdentityCookie(token, shellLocalPort);
      else await injectIdentityCookie(token);
    }
    setState({ user });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      teardownToLogin("session_expired");
    }
    // Any other failure (network blip) is left for the next tick — a
    // still-valid cookie keeps the shell window working in the meantime.
  }
}

function handleAuthSuccess(token: string, user: AwUser): { ok: true; user: AwUser } {
  currentToken = token;
  const storageWarning = persistSessionSafely(() => saveToken(token));
  setState({ user, error: null, openError: null, storageWarning });
  routeAfterAuth(user);
  return { ok: true, user };
}

const diagnosticsFile = (): string => join(app.getPath("userData"), "diagnostics.log");

/** Raw detail goes to the log; the caller gets plain copy only. */
function logFailure(context: string, err: unknown): ClassifiedError {
  const c = classifyError(err);
  appendDiagnostic(diagnosticsFile(), { context, code: c.code, raw: c.raw, account: currentSub() ?? "" });
  return c;
}

function apiFailure<T>(err: unknown, fallback: string): ApiResult<T> {
  if (err instanceof ApiError) {
    return { ok: false, error: err.message, code: err.code, status: err.status, limit: err.limit };
  }
  const msg = err instanceof Error ? err.message : fallback;
  // Local-engine failures never surface raw text; anything else keeps its own (non-engine) message.
  if (err instanceof PodmanCommandError || looksLikeEngineText(msg) || classifyError(err).code !== "start_failed") {
    const c = logFailure(fallback, err);
    return { ok: false, error: c.code === "start_failed" ? (ACTION_COPY[fallback] ?? c.message) : c.message, code: c.code };
  }
  return { ok: false, error: msg };
}

const ACTION_COPY: Record<string, string> = {
  create_failed: "Couldn't create the workspace. Try again, or copy details for support.",
  remove_failed: "Couldn't remove the workspace. Try again.",
};

function emitBootstrap(p: BootstrapProgress, isCurrent: () => boolean = () => true): void {
  if (!isCurrent()) return;
  bootstrapProgress = p;
  try {
    liveAuthWindow()?.webContents.send("aw:bootstrap-progress", p);
  } catch {
    // The picker window can vanish mid-send; setup must keep running.
  }
}

/** Caller must already hold the slot; this releases it. Brings the local workspace up, then opens it. */
async function startLocal(id: string, scope: SessionHandle): Promise<void> {
  try {
    if (!scope.isCurrent() || !currentToken) throw new Error("session_lost");
    emitBootstrap(startProgress(id), scope.isCurrent);
    const key = await identityPublicKey();
    await local.start(id, key, (step) => {
      if (bootstrapProgress && bootstrapProgress.slug === id) emitBootstrap(advance(bootstrapProgress, step), scope.isCurrent);
    });
    if (scope.isCurrent()) {
      emitBootstrap(complete(bootstrapProgress ?? startProgress(id)), scope.isCurrent);
      await openWorkspace(id, scope.isCurrent);
      // A done snapshot must not resurface when the picker is shown again.
      bootstrapProgress = null;
    }
  } catch (err) {
    const c = logFailure("start_local", err);
    emitBootstrap(fail(bootstrapProgress ?? startProgress(id), c.message, c.code), scope.isCurrent);
  } finally {
    scope.finish();
    setupSlot.release();
  }
}

/** Caller must already hold the slot; this releases it. Upgrades the local workspace to the bundled core, then opens it.
 * The workspace window (if open) is closed first: its core is stopped and swapped. On failure the previous core is restored. */
async function upgradeLocal(id: string, scope: SessionHandle): Promise<void> {
  try {
    if (!scope.isCurrent() || !currentToken) throw new Error("session_lost");
    emitBootstrap({ ...startProgress(id), kind: "upgrade" }, scope.isCurrent);
    const ws = local.registry.get(id);
    if (ws && shellLocalPort === ws.uiPort) {
      shellWindow?.close();
      shellWindow = null;
      shellLocalPort = null;
    }
    const key = cachedIdentityPublicKey() ?? (await identityPublicKey());
    await local.upgrade(id, key, (step) => {
      if (bootstrapProgress && bootstrapProgress.slug === id) emitBootstrap(advance(bootstrapProgress, step), scope.isCurrent);
    });
    if (scope.isCurrent()) {
      emitBootstrap(complete(bootstrapProgress ?? { ...startProgress(id), kind: "upgrade" }), scope.isCurrent);
      await openWorkspace(id, scope.isCurrent);
      bootstrapProgress = null;
    }
  } catch (err) {
    const c = logFailure("upgrade_local", err);
    const message = err instanceof UpgradeFailedError ? (err.rolledBack ? UPGRADE_COPY.failedRestored : UPGRADE_COPY.failedAttention) : c.message;
    emitBootstrap(fail(bootstrapProgress ?? { ...startProgress(id), kind: "upgrade" }, message, c.code), scope.isCurrent);
  } finally {
    scope.finish();
    setupSlot.release();
    if (local.registry.get(id)) liveAuthWindow()?.webContents.send("aw:workspace-status", local_row(id));
  }
}

/** Picking a local workspace that is not running yet starts it (same path as Finish setup). */
async function window_startLocal(id: string): Promise<{ ok: boolean; error?: string }> {
  const ws = local.registry.get(id);
  if (!ws || ws.sub !== currentSub()) return { ok: false, error: "unknown_workspace" };
  const r = await scopedExclusive<{ ok: boolean; error?: string }>(setupSlot, sessionScope, { ok: false, error: `A setup is already running on ${process.platform === "win32" ? "this PC" : "this Mac"}.` }, async (scope, handOff) => {
    handOff();
    void startLocal(id, scope);
    return { ok: true };
  });
  return r;
}

/** Bundled build identifiers written by scripts/fetch-ui.sh (public ids only). Absent in dev builds. */
function readBuildInfo(): { uiCommit?: string; coreImage?: string; tag?: string } {
  try {
    return JSON.parse(readFileSync(join(process.resourcesPath ?? "", "build-info.json"), "utf8")) as { uiCommit?: string; coreImage?: string; tag?: string };
  } catch {
    return {};
  }
}

/** Loopback /desktop/v1/* bridge for one local workspace (Settings > About). Reads only; the upgrade hook merely
 * asks the Picker to open its existing confirm modal, so a forged request can never start an upgrade. */
function desktopBridge(id: string) {
  return {
    async about() {
      const ws = local.registry.get(id);
      const supported = platformFor().supportsUpgrade;
      let vm: VmFacts = { state: "unknown", reason: "no workspace record" };
      if (supported) {
        vm = await vmFactsFromInspect(local.runtime.machineInspect(id));
      } else {
        vm = WINDOWS_VM;
      }
      return {
        app_version: app.getVersion(),
        build: readBuildInfo(),
        workspace: ws
          ? { id, pinned_image: pinnedImage(ws), bundled_image: WORKSPACE_IMAGE, upgrade_available: upgradeAvailable(ws), upgrade_supported: supported }
          : null,
        vm,
        host: await hostFacts(join(app.getPath("home"), "aw-workspaces")),
      };
    },
    requestUpgrade(): { status: number; body: Record<string, unknown> } {
      const ws = local.registry.get(id);
      if (!ws || ws.sub !== currentSub() || !currentToken) return { status: 403, body: { error: "unknown_workspace" } };
      if (!platformFor().supportsUpgrade) return { status: 409, body: { error: "upgrade_unsupported" } };
      if (!upgradeAvailable(ws)) return { status: 409, body: { error: "already_current" } };
      if (setupSlot.isBusy) return { status: 409, body: { error: "busy" } };
      // The Picker may not be mounted (workspace open leaves "loading-workspace", a closed window is recreated):
      // park the request in main, move to the Picker, and let it claim the request once it has mounted.
      const alive = liveAuthWindow();
      const pickerLive = !!alive && state.stage === "picker" && !alive.webContents.isLoading();
      pendingUpgrade = id;
      if (!alive) authWindow = createAuthWindow();
      if (state.stage !== "picker") setState({ stage: "picker", user: state.user, error: null, openError: null });
      authWindow!.show();
      authWindow!.focus();
      if (pickerLive) authWindow!.webContents.send("aw:request-upgrade", id);
      return { status: 202, body: { ok: true } };
    },
  };
}

/** Supervisor wiring: recovery runs inside the setup slot (never races Remove or a start), failures go to the log. */
function startLocalSupervisor(): void {
  local.startSupervisor({
    exclusive: async (work) => {
      if (!setupSlot.claim()) return "busy";
      try {
        await work();
        return "ok";
      } finally {
        setupSlot.release();
      }
    },
    onStatus: (id) => {
      recoveryBanner?.onStatus(id, local.supervisedStatus(id));
      if (local.registry.get(id)) liveAuthWindow()?.webContents.send("aw:workspace-status", local_row(id));
    },
    onFailure: (_id, err) => void logFailure("supervisor_recover", err),
    authKey: async () => cachedIdentityPublicKey() ?? (await identityPublicKey()),
  });
  // A force-quit leaves VMs running: stop them unless something already started.
  if (setupSlot.claim()) {
    void local
      .launchCleanup((_id, err) => void logFailure("launch_cleanup", err))
      .finally(() => setupSlot.release());
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("aw:getState", () => state);
  ipcMain.handle("aw:takePendingUpgrade", () => {
    const id = pendingUpgrade;
    pendingUpgrade = null;
    return id;
  });
  ipcMain.on("aw:banner-retry", (e) => {
    // Only the banner view itself may trigger it, never the hosted workspace page.
    if (bannerContentsId !== null && bannerContentsId === e.sender.id) void recoveryBanner?.retry();
  });

  ipcMain.handle("aw:login", async (_e, email: string, password: string) => {
    try {
      const { token, user } = await api.login(email, password);
      return handleAuthSuccess(token, user);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "login_failed" };
    }
  });

  ipcMain.handle("aw:signup", async (_e, email: string, password: string) => {
    try {
      const { token, user } = await api.signup(email, password);
      return handleAuthSuccess(token, user);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "signup_failed" };
    }
  });

  // Forgot-password routes into the same passwordless email-code flow
  // console already uses (Frederico's 2026-11-13 decision on the card) —
  // there is no separate reset-flow screen.
  ipcMain.handle("aw:startEmailCode", async (_e, email: string) => {
    try {
      await api.startEmailCode(email);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "send_failed" };
    }
  });

  ipcMain.handle("aw:verifyEmailCode", async (_e, email: string, code: string) => {
    try {
      const { token, user } = await api.verifyEmailCode(email, code);
      return handleAuthSuccess(token, user);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "verify_failed" };
    }
  });

  ipcMain.handle("aw:startGoogleSignIn", async () => {
    const code = await startGoogleSignInHandoff();
    if (!code) return { ok: false, error: "timed_out_or_cancelled" };
    try {
      const { token, user } = await api.exchangeGoogleCode(code);
      handleAuthSuccess(token, user);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "exchange_failed" };
    }
  });

  ipcMain.handle("aw:pickWorkspace", async (_e, slug: string) => {
    const lw = local.registry.get(slug);
    if (lw && (!local.isRunning(slug) || local.needsAttention(slug))) {
      const r = await window_startLocal(slug);
      return r;
    }
    const ok = await openWorkspace(slug);
    return ok ? { ok: true } : { ok: false, error: state.openError?.message ?? "open_failed" };
  });

  ipcMain.handle("aw:listWorkspaces", async (): Promise<ApiResult<WorkspaceListData>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    try {
      const cloud = (await api.listWorkspaces(currentToken)).filter((w) => w.placement_driver !== LOCAL_PLACEMENT);
      const sub = currentSub();
      const limit = await local.registry.resolveLimit(sub);
      const mine = local.rowsFor(sub);
      // Local rows come from this Mac's registry, never from the backend; the cap is per account.
      const account: AccountInfo = { limits: { max_local_workspaces: limit }, local_count: mine.length };
      return { ok: true, data: { workspaces: [...mine, ...cloud], account } };
    } catch (err) {
      return apiFailure(err, "list_failed");
    }
  });

  // Silent preflight: the wizard asks on open, and create re-checks here so a UI bypass cannot start a VM.
  ipcMain.handle("aw:preflight", () => preflight());

  ipcMain.handle("aw:getBootstrapProgress", () => bootstrapProgress);

  // "Copy details": the raw log never goes to the renderer, main puts it on the clipboard.
  ipcMain.handle("aw:copyDiagnostics", () => {
    const tail = readDiagnosticTail(diagnosticsFile(), currentSub() ?? "");
    if (!tail) return false;
    clipboard.writeText(tail);
    return true;
  });

  const BUSY = { ok: false, error: `A setup is already running on ${process.platform === "win32" ? "this PC" : "this Mac"}.`, code: "bootstrap_running" } as const;

  // Cap is enforced HERE (main process), per signed-in account, before anything is created.
  ipcMain.handle("aw:createLocalWorkspace", async (_e, name: string): Promise<ApiResult<WorkspaceInfo>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    const sub = currentSub();
    if (!sub) return { ok: false, error: "session_lost" };
    // Bound to the session at IPC entry, before any await.
    return scopedExclusive<ApiResult<WorkspaceInfo>>(setupSlot, sessionScope, BUSY, async (scope, handOff) => {
      try {
        const pre = await preflight();
        // Sign-out can land while the probe runs: never create a registry row for a dead session.
        if (!scope.isCurrent()) return { ok: false, error: "session_lost" };
        if (!pre.ok) return { ok: false, error: pre.message, code: pre.code };
        const ws = await local.registry.create(sub, name);
        const row = local_row(ws.id);
        if (!scope.isCurrent()) return { ok: true, data: row };
        handOff();
        void startLocal(ws.id, scope);
        return { ok: true, data: row };
      } catch (err) {
        if (err instanceof LocalLimitReachedError) {
          return { ok: false, error: err.message, code: "plan_limit_local_workspaces", status: 402, limit: err.limit };
        }
        return apiFailure(err, "create_failed");
      }
    });
  });

  // Start / resume / retry an existing local workspace: never creates one.
  ipcMain.handle("aw:finishLocalSetup", async (_e, id: string): Promise<ApiResult<null>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    return scopedExclusive<ApiResult<null>>(setupSlot, sessionScope, BUSY, async (scope, handOff) => {
      const ws = local.registry.get(id);
      if (!ws || ws.sub !== currentSub()) return { ok: false, error: "unknown_workspace" };
      handOff();
      void startLocal(id, scope);
      return { ok: true, data: null };
    });
  });

  // Explicit, user-confirmed upgrade of one local workspace to the bundled core. Never runs on its own.
  ipcMain.handle("aw:upgradeLocalWorkspace", async (_e, id: string): Promise<ApiResult<null>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    return scopedExclusive<ApiResult<null>>(setupSlot, sessionScope, BUSY, async (scope, handOff) => {
      const ws = local.registry.get(id);
      if (!ws || ws.sub !== currentSub()) return { ok: false, error: "unknown_workspace" };
      if (!platformFor().supportsUpgrade) return { ok: false, error: "upgrade_unsupported", code: "upgrade_unsupported" };
      if (!upgradeAvailable(ws)) return { ok: false, error: "already_current", code: "already_current" };
      const pre = await preflight();
      if (!scope.isCurrent()) return { ok: false, error: "session_lost" };
      if (!pre.ok) return { ok: false, error: pre.message, code: pre.code };
      handOff();
      void upgradeLocal(id, scope);
      return { ok: true, data: null };
    });
  });

  // Remove a local workspace and all of its data. Same slot as setup, so it can never race a bootstrap.
  ipcMain.handle("aw:removeLocalWorkspace", async (_e, id: string): Promise<ApiResult<null>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    return scopedExclusive<ApiResult<null>>(setupSlot, sessionScope, BUSY, async () => {
      const ws = local.registry.get(id);
      if (!ws || ws.sub !== currentSub()) return { ok: false, error: "unknown_workspace" };
      try {
        if (shellLocalPort === ws.uiPort) {
          shellWindow?.close();
          shellWindow = null;
          shellLocalPort = null;
        }
        await local.destroy(id);
        // The port is released: its token must not outlive the workspace (the port can be reused).
        void clearLocalIdentityCookies([ws.uiPort]).catch(() => undefined);
        if (bootstrapProgress?.slug === id) bootstrapProgress = null;
        return { ok: true, data: null };
      } catch (err) {
        return apiFailure(err, "remove_failed");
      }
    });
  });

  ipcMain.handle("aw:logout", () => logout());
}

function local_row(id: string): WorkspaceInfo {
  const w = local.registry.get(id)!;
  return local.rowsFor(w.sub).find((r) => r.name === id)!;
}

/** Best-effort server logout (3s cap) — teardown ALWAYS runs, so a failed
 * or hanging network call can never leave the user stuck logged in. */
async function logout(): Promise<void> {
  const token = currentToken;
  if (token) {
    try {
      await Promise.race([
        api.logout(token),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // ignore: local teardown below is what matters
    }
  }
  teardownToLogin(null);
}

/** Closes the workspace window and shows the native picker, even for a
 * user with a single membership. Re-fetches /me so new workspaces appear. */
async function switchWorkspace(): Promise<void> {
  if (!currentToken) return teardownToLogin("session_lost");
  let user = state.user;
  try {
    user = await api.me(currentToken);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return teardownToLogin("session_expired");
    }
  }
  shellWindow?.close();
  shellWindow = null;
  if (!authWindow || authWindow.isDestroyed()) authWindow = createAuthWindow();
  authWindow.show();
  authWindow.focus();
  setState({ stage: "picker", user, error: null });
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      {
        label: "Workspace",
        submenu: [
          { label: "Switch Workspace…", accelerator: "CmdOrCtrl+Shift+W", click: () => void switchWorkspace() },
          { label: "Log out", accelerator: "CmdOrCtrl+Shift+L", click: () => void logout() },
        ],
      },
      { role: "editMenu" as const },
      { role: "viewMenu" as const },
      { role: "windowMenu" as const },
    ]),
  );
}

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerIpcHandlers();
  buildAppMenu();
  await bootstrap();

  setInterval(refreshLoop, REFRESH_INTERVAL_MS);
  powerMonitor.on("resume", () => {
    void refreshLoop();
    void local.checkNow();
    void checkForUpdates();
  });
  local.setDesktopBridge(desktopBridge);
  startLocalSupervisor();
  void refreshLoop();
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), UPDATE_RECHECK_MS);
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // Local workspaces only run while the app runs: stop their machines, then really quit.
  // app.exit() skips electron-updater's install-on-quit hook, so install a downloaded update explicitly.
  void local.stopAll().finally(async () => {
    // quitAndInstall can fail silently (no event on a failed Squirrel/installer hand-off): never
    // leave the app running with its workspaces stopped.
    const installing = await installPendingUpdate().catch(() => false);
    if (installing) setTimeout(() => app.exit(0), INSTALL_QUIT_GRACE_MS).unref();
    else app.exit(0);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});
