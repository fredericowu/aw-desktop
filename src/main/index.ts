import { app, ipcMain, powerMonitor, BrowserWindow, Menu } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_BASE, APEX, CONSOLE_BASE, workspaceUrl } from "./config";
import * as api from "./apiClient";
import { ApiError } from "./apiClient";
import { loadToken, saveToken, clearToken } from "./authStore";
import { injectIdentityCookie, clearIdentityCookie } from "./cookie";
import { registerProtocolHandler, startGoogleSignInHandoff } from "./oauth";
import { createAuthWindow, createShellWindow } from "./windows";
import { checkForUpdates } from "./updater";
import { probeRuntimes } from "./runtimeProbe";
import { openIfCurrent, SessionScope, type SessionHandle, SetupSlot, scopedExclusive, killActiveBootstrap, preflightFor, readHostStatus, realHostOps, runBootstrapFlow } from "./localBootstrap";
import { decidePreflight, fail, startProgress } from "./bootstrapCore";
import type { ApiResult, AuthState, AwUser, BootstrapProgress, WorkspaceInfo, WorkspaceListData } from "../shared/types";

// macOS only (Phase 1, per Architect design) — a second instance just
// focuses the first rather than opening twice, which also keeps a single
// process around to receive the `open-url` OAuth callback.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const ACCOUNT_TIMEOUT_MS = 4000;

let authWindow: BrowserWindow | null = null;
let shellWindow: BrowserWindow | null = null;
let currentToken: string | null = null;

let bootstrapProgress: BootstrapProgress | null = null;
const setupSlot = new SetupSlot();
/** A setup job belongs to the sign-in session that started it. */
const sessionScope = new SessionScope();

let state: AuthState = { stage: "splash", user: null, error: null, apex: APEX };

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
  shellWindow?.close();
  shellWindow = null;
  if (!authWindow || authWindow.isDestroyed()) authWindow = createAuthWindow();
  authWindow.show();
  setState({ stage: "login", user: null, error });
}

/** Every authenticated user lands on the Local/Cloud picker — with 0, 1 or
 * N memberships. The picker is where the guided local create lives, so a
 * single membership no longer skips it. */
function routeAfterAuth(user: AwUser): void {
  setState({ stage: "picker", user, error: null });
}

async function openWorkspace(slug: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (!currentToken) return teardownToLogin("session_lost");
  const token = currentToken;
  setState({ stage: "loading-workspace", error: null });
  await openIfCurrent(
    isCurrent,
    () => injectIdentityCookie(token),
    () => {
      liveAuthWindow()?.hide();
      shellWindow = createShellWindow(workspaceUrl(slug));
      watchForSessionExpiry(shellWindow);
    },
    // Signed out while the cookie was being written: don't leave it behind.
    () => void clearIdentityCookie().catch(() => undefined),
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
    if (shellWindow === win) shellWindow = null;
  });
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
    saveToken(token);
    if (shellWindow) await injectIdentityCookie(token);
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
  saveToken(token);
  setState({ user, error: null });
  routeAfterAuth(user);
  return { ok: true, user };
}

function apiFailure<T>(err: unknown, fallback: string): ApiResult<T> {
  if (err instanceof ApiError) {
    return { ok: false, error: err.message, code: err.code, status: err.status, limit: err.limit };
  }
  return { ok: false, error: err instanceof Error ? err.message : fallback };
}

function emitBootstrap(p: BootstrapProgress, isCurrent: () => boolean = () => true): void {
  if (!isCurrent()) return;
  bootstrapProgress = p;
  try {
    liveAuthWindow()?.webContents.send("aw:bootstrap-progress", p);
  } catch {
    // The picker window can vanish mid-send; setup must keep running.
  }
}

/** When the CLI last detached per slug, persisted so a relaunch does not start a second installer. */
const handoffStore = {
  file: () => join(app.getPath("userData"), "bootstrap-handoff.json"),
  read(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.file(), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  },
  lastLaunchedAt(slug: string): number | null {
    return this.read()[slug] ?? null;
  },
  markLaunched(slug: string, at: number): void {
    try {
      writeFileSync(this.file(), JSON.stringify({ ...this.read(), [slug]: at }));
    } catch {
      // best effort: worst case a Retry re-runs the (idempotent) bootstrap
    }
  },
};

/** Caller must already hold the slot; this releases it. */
async function startBootstrap(slug: string, scope: SessionHandle): Promise<void> {
  // The job only ever acts as the session that started it.
  const live = () => {
    if (!scope.isCurrent() || !currentToken) throw new Error("session_lost");
    return currentToken;
  };
  try {
    const result = await runBootstrapFlow(slug, {
      ops: realHostOps(),
      // The token only ever lives in this closure's return value: not logged, not persisted.
      mintToken: async (s) => (await api.mintBootstrapToken(live(), s)).token,
      getStatus: async (s, signal) => (await api.getWorkspace(live(), s, signal)).status,
      getRowHostId: async (s) => (await api.getWorkspace(live(), s)).remote_host_id ?? null,
      controlPlane: API_BASE,
      emit: (p) => emitBootstrap(p, scope.isCurrent),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      signal: scope.signal,
      handoff: handoffStore,
    });
    if (result.phase === "done" && scope.isCurrent()) {
      await openWorkspace(slug, scope.isCurrent);
      // A done snapshot must not resurface when the picker is shown again.
      bootstrapProgress = null;
    }
  } catch (err) {
    emitBootstrap(fail(bootstrapProgress ?? startProgress(slug), err instanceof Error ? err.message : String(err)), scope.isCurrent);
  } finally {
    scope.finish();
    setupSlot.release();
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("aw:getState", () => state);

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
    await openWorkspace(slug);
    return { ok: true };
  });

  ipcMain.handle("aw:listWorkspaces", async (): Promise<ApiResult<WorkspaceListData>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    try {
      const workspaces = await api.listWorkspaces(currentToken);
      // limits/local_count only exist on a backend with max_local_workspaces;
      // a failure here must not hide the list.
      const account = await Promise.race([
        api.accountMe(currentToken).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ACCOUNT_TIMEOUT_MS)),
      ]);
      return { ok: true, data: { workspaces, account } };
    } catch (err) {
      return apiFailure(err, "list_failed");
    }
  });

  ipcMain.handle("aw:checkRuntime", () => probeRuntimes());

  ipcMain.handle("aw:getLocalHost", () => readHostStatus(realHostOps()));
  ipcMain.handle("aw:getBootstrapProgress", () => bootstrapProgress);

  // Pre-flight FIRST: a Mac that already hosts a workspace is refused before
  // a row exists or a token is minted. Then the REAL BYOD row, then the
  // bootstrap runs in the background (progress over aw:bootstrap-progress).
  const BUSY = { ok: false, error: "A setup is already running on this Mac.", code: "bootstrap_running" } as const;

  ipcMain.handle("aw:createLocalWorkspace", async (_e, name: string): Promise<ApiResult<WorkspaceInfo>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    const token = currentToken;
    // Bound to the session at IPC entry, before any await: a response that
    // lands after sign-out/sign-in must never run as the new user.
    return scopedExclusive<ApiResult<WorkspaceInfo>>(setupSlot, sessionScope, BUSY, async (scope, handOff) => {
      try {
        const pre = decidePreflight(await readHostStatus(realHostOps()));
        if (pre.action === "block") return { ok: false, error: pre.message, code: "already_linked" };
        if (!scope.isCurrent()) return { ok: false, error: "session_lost" };
        const row = await api.createWorkspace(token, name);
        // The row exists for the original account; only that session may drive it.
        if (!scope.isCurrent()) return { ok: true, data: row };
        handOff();
        void startBootstrap(row.name, scope);
        return { ok: true, data: row };
      } catch (err) {
        return apiFailure(err, "create_failed");
      }
    });
  });

  // Resume/retry for a row that exists but never came up: never creates a row.
  ipcMain.handle("aw:finishLocalSetup", async (_e, slug: string): Promise<ApiResult<null>> => {
    if (!currentToken) return { ok: false, error: "session_lost" };
    return scopedExclusive<ApiResult<null>>(setupSlot, sessionScope, BUSY, async (scope, handOff) => {
      try {
        const tk = currentToken as string;
        const pre = await preflightFor(await readHostStatus(realHostOps()), slug, async (s) => (await api.getWorkspace(tk, s)).remote_host_id ?? null);
        if (pre.action === "block") return { ok: false, error: pre.message, code: "already_linked" };
        if (!scope.isCurrent()) return { ok: false, error: "session_lost" };
        handOff();
        void startBootstrap(slug, scope);
        return { ok: true, data: null };
      } catch (err) {
        return apiFailure(err, "setup_failed");
      }
    });
  });

  ipcMain.handle("aw:logout", () => logout());
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
  powerMonitor.on("resume", () => void refreshLoop());
  void refreshLoop();
  void checkForUpdates();
});

app.on("before-quit", () => killActiveBootstrap());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});
