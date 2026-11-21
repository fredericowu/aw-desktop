import { APEX } from "./config";

/** A local workspace window also allows its own loopback origin (and nothing else on 127.0.0.1). */
export function isAllowedTarget(targetUrl: string, localOrigin?: string): boolean {
  if (localOrigin) {
    try {
      if (new URL(targetUrl).origin === new URL(localOrigin).origin) return true;
    } catch {
      return false;
    }
  }
  return isAllowedHost(targetUrl);
}

function isAllowedHost(targetUrl: string): boolean {
  try {
    const host = new URL(targetUrl).hostname;
    return host === APEX || host.endsWith(`.${APEX}`);
  } catch {
    return false;
  }
}
