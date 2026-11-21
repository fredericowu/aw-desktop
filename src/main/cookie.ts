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

export async function clearLocalIdentityCookies(ports: number[]): Promise<void> {
  await Promise.all(ports.map((p) => electronSession.defaultSession.cookies.remove(`http://127.0.0.1:${p}/`, COOKIE_NAME)));
}
