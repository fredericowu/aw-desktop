import { app, shell } from "electron";
import { API_BASE, NATIVE_CLIENT_SLUG, PROTOCOL_SCHEME } from "./config";
import { extractCode, findProtocolUrl } from "./oauthCore";

/** Google SSO via the system browser + the existing native_oauth_handoff.py
 * custom-scheme flow (card 4175bf3b-9510-8104-8c21-f5008b4d708b §2). Google
 * rejects sign-in from embedded webviews, so this app registers
 * `awdesktop://auth` and the ONE backend change this design needs —
 * `"mac": "awdesktop://auth"` in aw-backend's NATIVE_CLIENTS — hands the
 * one-time code back on that scheme instead of a cookie this app cannot
 * read.
 *
 * A wrong/unregistered scheme does not error anywhere: the sign-in sheet
 * just never comes back (native_oauth_handoff.py:63-65's own warning).
 * Verify the full round-trip, not just that the browser opened. */

let pendingResolve: ((code: string | null) => void) | null = null;

export function registerProtocolHandler(): void {
  if (!app.isDefaultProtocolClient(PROTOCOL_SCHEME)) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }

  // macOS delivers the custom-scheme open as this event, not argv.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliver(url);
  });
  // Windows/Linux: the OS starts a second instance with the URL in argv; the single-instance lock forwards it here.
  app.on("second-instance", (_event, argv) => {
    const url = findProtocolUrl(argv, PROTOCOL_SCHEME);
    if (url) deliver(url);
  });
}

function deliver(url: string): void {
  const code = extractCode(url);
  if (pendingResolve) {
    pendingResolve(code);
    pendingResolve = null;
  }
}

/** Opens the system browser on the Google start endpoint and resolves once
 * the OS hands the app back a `awdesktop://auth?code=...` callback, or on a
 * 2-minute timeout (covers an abandoned/closed browser tab). */
export async function startGoogleSignInHandoff(): Promise<string | null> {
  const url = `${API_BASE}/api/identity/google/start?client=${NATIVE_CLIENT_SLUG}`;
  await shell.openExternal(url);

  return new Promise((resolve) => {
    pendingResolve = resolve;
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        resolve(null);
      }
    }, 120_000);
  });
}
