import { mkdtempSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthStore, type SafeStorageLike } from "../src/main/authStoreCore";

const mk = (s: SafeStorageLike) => {
  const dir = mkdtempSync(join(tmpdir(), "awauth-"));
  return { dir, store: new AuthStore(() => dir, () => s) };
};
const good = (): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from("enc:" + t),
  decryptString: (b) => b.toString().slice(4),
});
const throwing = () => {
  const fn = vi.fn(() => { throw new Error("Keychain Not Found"); });
  return { s: { isEncryptionAvailable: fn, encryptString: fn, decryptString: fn } as SafeStorageLike, fn };
};

describe("AuthStore", () => {
  it("never touches safeStorage when there is nothing to load", () => {
    const { s, fn } = throwing();
    const { store } = mk(s);
    expect(store.load()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("round-trips through safeStorage when it works", () => {
    const { store } = mk(good());
    store.save("jwt");
    expect(store.load()).toBe("jwt");
  });

  it("throwing safeStorage: save falls back to a 0600 file, calls it once, persists the flag", () => {
    const { s, fn } = throwing();
    const { dir, store } = mk(s);
    store.save("jwt");
    expect(fn).toHaveBeenCalledTimes(1);
    store.save("jwt2");
    expect(store.load()).toBe("jwt2");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "safestorage-disabled"))).toBe(true);
    expect(statSync(join(dir, "session.json")).mode & 0o777).toBe(0o600);
    // a new process (fresh instance) never calls it either
    const { s: s2, fn: fn2 } = throwing();
    expect(new AuthStore(() => dir, () => s2).load()).toBe("jwt2");
    expect(fn2).not.toHaveBeenCalled();
  });

  it("hanging safeStorage (attempt marker left behind) is skipped on next launch", () => {
    const { s, fn } = throwing();
    const { dir, store } = mk(s);
    writeFileSync(join(dir, "session.bin"), "x");
    writeFileSync(join(dir, "safestorage-attempt"), "1");
    expect(store.load()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    store.save("jwt");
    expect(fn).not.toHaveBeenCalled();
    expect(store.load()).toBe("jwt");
    expect(readFileSync(join(dir, "safestorage-disabled"), "utf8")).not.toBe("");
  });

  it("clear removes both files", () => {
    const { s } = throwing();
    const { dir, store } = mk(s);
    store.save("jwt");
    store.clear();
    expect(existsSync(join(dir, "session.json"))).toBe(false);
    expect(store.load()).toBeNull();
  });
});
