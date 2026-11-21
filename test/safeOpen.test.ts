import { describe, expect, it, vi } from "vitest";
import { describeError, guardedOpen, persistSessionSafely } from "../src/main/safeOpen";

describe("guardedOpen", () => {
  it("returns true and reports nothing when the open succeeds", async () => {
    const onError = vi.fn();
    expect(await guardedOpen("ws", async () => undefined, onError)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("swallows a cookie failure and reports slug + message", async () => {
    const onError = vi.fn();
    const ok = await guardedOpen("ws", async () => { throw new Error("Failed to set cookie"); }, onError);
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith({ slug: "ws", message: "Failed to set cookie" });
  });

  it("handles non-Error rejections", async () => {
    const onError = vi.fn();
    await guardedOpen("ws", () => Promise.reject("boom"), onError);
    expect(onError).toHaveBeenCalledWith({ slug: "ws", message: "boom" });
    expect(describeError(new Error(""))).toBe("Error");
  });
});

describe("persistSessionSafely", () => {
  it("returns null when saving works", () => {
    expect(persistSessionSafely(() => undefined)).toBeNull();
  });

  it("turns a Keychain failure into a warning instead of throwing", () => {
    const w = persistSessionSafely(() => { throw new Error("OS-level encryption (Keychain) is unavailable"); });
    expect(w).toContain("Keychain");
    expect(w).toContain("this run only");
  });
});
