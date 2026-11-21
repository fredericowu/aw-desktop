import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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

  it("throwing safeStorage: called once, in-memory only, no plaintext, flag persisted, one log line", () => {
    const { s, fn } = throwing();
    const dir = mkdtempSync(join(tmpdir(), "awauth-"));
    const log = vi.fn();
    const store = new AuthStore(() => dir, () => s, log);
    store.save("jwt");
    expect(fn).toHaveBeenCalledTimes(1);
    store.save("jwt2");
    expect(store.load()).toBe("jwt2");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "safestorage-disabled"))).toBe(true);
    expect(existsSync(join(dir, "session.json"))).toBe(false);
    // a new process (fresh instance) never calls it and is signed out
    const { s: s2, fn: fn2 } = throwing();
    expect(new AuthStore(() => dir, () => s2, log).load()).toBeNull();
    expect(fn2).not.toHaveBeenCalled();
  });

  it("availability is probed once across many ops when the keychain works", () => {
    const probe = vi.fn(() => true);
    const { store } = mk({ ...good(), isEncryptionAvailable: probe });
    store.save("a");
    store.save("b");
    store.clear();
    store.save("c");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers hit safeStorage exactly once", async () => {
    const probe = vi.fn(() => { throw new Error("Keychain Not Found"); });
    const { store } = mk({ ...good(), isEncryptionAvailable: probe });
    await Promise.all([
      Promise.resolve().then(() => store.save("a")),
      Promise.resolve().then(() => store.save("b")),
      Promise.resolve().then(() => store.load()),
      Promise.resolve().then(() => store.save("c")),
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("failure then no retry in the same session", () => {
    const { s, fn } = throwing();
    const { dir, store } = mk(s);
    writeFileSync(join(dir, "session.bin"), "x");
    expect(store.load()).toBeNull();
    store.save("jwt");
    expect(store.load()).toBe("jwt"); // in-memory only
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("legacy plaintext session.json is not trusted and is removed", () => {
    const { s } = throwing();
    const { dir, store } = mk(s);
    writeFileSync(join(dir, "session.json"), "old");
    expect(store.load()).toBeNull();
    expect(existsSync(join(dir, "session.json"))).toBe(false);
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
    writeFileSync(join(dir, "session.bin"), "x");
    store.save("jwt");
    store.clear();
    expect(existsSync(join(dir, "session.bin"))).toBe(false);
    expect(store.load()).toBeNull();
  });
});
