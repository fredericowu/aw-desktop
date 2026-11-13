import { app, ipcMain, powerMonitor, BrowserWindow } from "electron";
import { APEX, CONSOLE_BASE, workspaceUrl } from "./config";
import * as api from "./apiClient";
import { ApiError } from "./apiClient";
import { loadToken, saveToken, clearToken } from "./authStore";
import { injectIdentityCookie, clearIdentityCookie } from "./cookie";
import { registerProtocolHandler, startGoogleSignInHandoff } from "./oauth";
import { createAuthWindow, createShellWindow } from "./windows";
import { checkForUpdates } from "./updater";
import type { AuthState, AwUser } from "../shared/types";

// macOS only (Phase 1, per Architect design) — a second instance just
// focuses the first rather than opening twice, which also keeps a single
// process around to receive the `open-url` OAuth callback.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let authWindow: BrowserWindow | null = null;
let shellWindow: BrowserWindow | null = null;
let currentToken: string | null = null;

let state: AuthState = { stage: "splash", user: null, error: null, apex: APEX };

function setState(partial: Partial<AuthState>): void {
  state = { ...state, ...partial };
  authWindow?.webContents.send("aw:state-changed", state);
}

function teardownToLogin(error: string | null = null): void {
  currentToken = null;
  clearToken();
  clearIdentityCookie().catch(() => undefined);
  shellWindow?.close();
  shellWindow = null;
  if (!authWindow || authWindow.isDestroyed()) authWindow = createAuthWindow();
  authWindow.show();
  setState({ stage: "login", user: null, error });
}

/** Routes a freshly-authenticated user per the Architect design §2:
 * exactly one membership loads straight into the shell, several show the
 * native picker, zero sends them into the console's workspace-creation
 * page (still inside an authenticated webview, not rebuilt natively). */
function routeAfterAuth(user: AwUser): void {
  if (user.memberships.length === 1) {
    void openWorkspace(user.memberships[0].workspace);
  } else if (user.memberships.length === 0) {
    void openWorkspaceCreation();
  } else {
    setState({ stage: "picker", user, error: null });
  }
}

async function openWorkspace(slug: string): Promise<void> {
  if (!currentToken) return teardownToLogin("session_lost");
  setState({ stage: "loading-workspace", error: null });
  await injectIdentityCookie(currentToken);
  authWindow?.hide();
  shellWindow = createShellWindow(workspaceUrl(slug));
  watchForSessionExpiry(shellWindow);
}

/** Zero-membership path: load the console's "new workspace" page inside
 * an authenticated shell window and watch for the redirect into the
 * created workspace's own subdomain — per the design, workspace creation
 * is never rebuilt as a native screen. */
async function openWorkspaceCreation(): Promise<void> {
  if (!currentToken) return teardownToLogin("session_lost");
  setState({ stage: "loading-workspace", error: null });
  await injectIdentityCookie(currentToken);
  authWindow?.hide();
  shellWindow = createShellWindow(`${CONSOLE_BASE}/workspaces/new`);
  shellWindow.webContents.on("did-navigate", (_event, url) => {
    const match = /^https:\/\/([^.]+)\.workspace\./.exec(url);
    if (match) watchForSessionExpiry(shellWindow!);
  });
  watchForSessionExpiry(shellWindow);
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

  ipcMain.handle("aw:createWorkspace", async () => {
    await openWorkspaceCreation();
    return { ok: true };
  });

  ipcMain.handle("aw:logout", async () => {
    if (currentToken) await api.logout(currentToken);
    teardownToLogin(null);
  });
}

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerIpcHandlers();
  await bootstrap();

  setInterval(refreshLoop, REFRESH_INTERVAL_MS);
  powerMonitor.on("resume", () => void refreshLoop());
  void refreshLoop();
  void checkForUpdates();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});
