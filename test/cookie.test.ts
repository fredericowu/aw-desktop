import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ session: { defaultSession: { cookies: { set: vi.fn(), remove: vi.fn() }, webRequest: { onBeforeSendHeaders: vi.fn() } } } }));

import { appHostCookie, clearLocalIdentityCookies, injectLocalIdentityCookie, revokeAllLocalAppTokens, withAppCookie } from "../src/main/cookie";

const tokens = new Map([[9031, "JWT"]]);

describe("appHostCookie", () => {
  it.each(["http://kali-linux.app.localhost:9031/", "ws://code-server.app.localhost:9031/websockify?x=1"])("adds the cookie for %s", (u) => {
    expect(appHostCookie(u, tokens)).toBe("aw_id_jwt=JWT");
  });
  it.each([
    "http://kali-linux.app.localhost:9999/", // port of no open workspace
    "http://kali-linux.app.localhost/", // port 80
    "http://127.0.0.1:9031/", // the shell itself is handled by the jar
    "http://evil.com:9031/",
    "http://kali-linux.app.localhost.evil.com:9031/",
    "http://a.b.app.localhost:9031/",
    "http://app.localhost:9031/",
    "https://kali-linux.app.localhost:9031/",
    "not a url",
  ])("never adds it for %s", (u) => {
    expect(appHostCookie(u, tokens)).toBeNull();
  });
});

describe("withAppCookie", () => {
  it("sets, appends, and never duplicates", () => {
    expect(withAppCookie(undefined, "aw_id_jwt=T")).toBe("aw_id_jwt=T");
    expect(withAppCookie("a=1", "aw_id_jwt=T")).toBe("a=1; aw_id_jwt=T");
    expect(withAppCookie("a=1; aw_id_jwt=OLD", "aw_id_jwt=T")).toBe("a=1; aw_id_jwt=OLD");
  });
});

describe("token lifecycle", () => {
  it("clearLocalIdentityCookies([port]) and revokeAllLocalAppTokens drop the app-host token", async () => {
    const url = "http://kali-linux.app.localhost:9055/";
    await injectLocalIdentityCookie("T1", 9055);
    await injectLocalIdentityCookie("T2", 9056);
    expect(appHostCookie(url)).toBe("aw_id_jwt=T1");
    await clearLocalIdentityCookies([9055]);
    expect(appHostCookie(url)).toBeNull();
    expect(appHostCookie("http://kali-linux.app.localhost:9056/")).toBe("aw_id_jwt=T2");
    revokeAllLocalAppTokens(); // logout, even for a port no longer in the registry
    expect(appHostCookie("http://kali-linux.app.localhost:9056/")).toBeNull();
  });
});
