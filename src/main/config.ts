/** Apex domain the shell talks to. Configurable for the open-source/BYO
 * story (Architect design, card 4175bf3b-9510-8104-8c21-f5008b4d708b §3) —
 * default matches the hosted product. */
export const APEX = (process.env.AW_DESKTOP_APEX || "aw.tekflox.com").trim();

export const API_BASE = `https://api.${APEX}`;
export const CONSOLE_BASE = `https://console.${APEX}`;

export function workspaceUrl(slug: string): string {
  return `https://${slug}.workspace.${APEX}`;
}

/** Matches `_cookie_domain_for` in aw-backend (src/api/routes/auth.py) —
 * the cookie is shared across every *.workspace.<apex> subdomain. */
export const COOKIE_DOMAIN = APEX;

export const PROTOCOL_SCHEME = "awdesktop";
export const NATIVE_CLIENT_SLUG = "mac";
