import { session as electronSession } from "electron";
import { COOKIE_DOMAIN } from "./config";

const COOKIE_NAME = "aw_id_jwt";

/** Inject the identity JWT into the default session's cookie jar on the
 * apex domain, mirroring `_issue_identity_cookie` (aw-backend
 * src/api/routes/social_login.py:138-149) and `_cookie_domain_for`
 * (src/api/routes/auth.py:26-40) attribute-for-attribute, so every
 * *.workspace.<apex> subdomain the shell window loads sees it and the
 * SPA's own `/api/auth/status` gate passes with zero UI changes. */
export async function injectIdentityCookie(token: string): Promise<void> {
  await electronSession.defaultSession.cookies.set({
    url: `https://${COOKIE_DOMAIN}/`,
    name: COOKIE_NAME,
    value: token,
    domain: COOKIE_DOMAIN,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: Date.now() / 1000 + 365 * 24 * 3600,
  });
}

export async function clearIdentityCookie(): Promise<void> {
  await electronSession.defaultSession.cookies.remove(`https://${COOKIE_DOMAIN}/`, COOKIE_NAME);
}

/** Local (standalone) workspaces are served from http://127.0.0.1:<uiPort>, a different origin
 * from the apex, so the identity JWT needs its own host-only cookie there. The front server
 * only passes it through; it never adds credentials itself. */
export async function injectLocalIdentityCookie(token: string, uiPort: number): Promise<void> {
  localTokens.set(uiPort, token);
  installAppHostCookieHook();
  await electronSession.defaultSession.cookies.set({
    url: `http://127.0.0.1:${uiPort}/`,
    name: COOKIE_NAME,
    value: token,
    path: "/",
    secure: false,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: Date.now() / 1000 + 365 * 24 * 3600,
  });
}

/** Forget every app-host token (logout): independent of the registry, which may no longer list a removed workspace's port. */
export function revokeAllLocalAppTokens(): void {
  localTokens.clear();
}

export async function clearLocalIdentityCookies(ports: number[]): Promise<void> {
  for (const p of ports) localTokens.delete(p);
  await Promise.all(ports.map((p) => electronSession.defaultSession.cookies.remove(`http://127.0.0.1:${p}/`, COOKIE_NAME)));
}

// Container-app windows (kali, code-server, ...) load from `<app>.app.localhost:<uiPort>`, another
// site from the shell's 127.0.0.1. Measured on Chromium (Mac mini, Electron): a Domain=localhost or
// Domain=.localhost cookie is NOT sent to `*.app.localhost`, and a SameSite=Lax cookie would not ride
// the cross-site iframe anyway. So the identity JWT is attached to requests (HTTP + WebSocket) bound
// for exactly `<app>.app.localhost:<uiPort>` of an open local workspace, and never stored for them.
const localTokens = new Map<number, string>();
const APP_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.app\.localhost$/;

/** The Cookie header value to add for a request URL, or null when it is not an app host of an open local workspace. */
export function appHostCookie(rawUrl: string, tokens: ReadonlyMap<number, string> = localTokens): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "ws:") return null;
  if (!APP_HOST.test(u.hostname)) return null;
  const token = tokens.get(Number(u.port));
  return token ? `${COOKIE_NAME}=${token}` : null;
}

/** Merge into an existing Cookie header without clobbering it; a cookie the page already sent wins. */
export function withAppCookie(existing: string | undefined, add: string): string {
  if (!existing) return add;
  return existing.split(";").some((c) => c.trim().startsWith(`${COOKIE_NAME}=`)) ? existing : `${existing}; ${add}`;
}

let hookInstalled = false;
function installAppHostCookieHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  electronSession.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["http://*.app.localhost/*", "ws://*.app.localhost/*"] }, (details, cb) => {
    const add = appHostCookie(details.url);
    if (!add) return cb({});
    const headers = { ...details.requestHeaders };
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "cookie");
    headers[key ?? "Cookie"] = withAppCookie(key ? headers[key] : undefined, add);
    cb({ requestHeaders: headers });
  });
}
