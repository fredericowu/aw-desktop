import { afterEach, describe, expect, it, vi } from "vitest";
import { openIfCurrent, scopedExclusive, SessionScope, SetupSlot, fetchBytes, exclusive } from "../src/main/localBootstrap";

describe("session scope", () => {
  it("a request that began before sign-out is not current after sign-out + sign-in, even when it resolves late", async () => {
    const slot = new SetupSlot();
    const scope = new SessionScope();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let currentAfterAwait: boolean | null = null;
    const pending = scopedExclusive(slot, scope, "busy", async (session) => {
      await gate; // e.g. createWorkspace response arriving late
      currentAfterAwait = session.isCurrent();
      return "done";
    });
    scope.end(); // A logs out
    scope.begin(); // B signs in and starts something
    release();
    await pending;
    expect(currentAfterAwait).toBe(false);
  });

  it("openIfCurrent: sign-out during the cookie write never opens the shell and undoes the cookie", async () => {
    let current = true;
    const log: string[] = [];
    const ok = await openIfCurrent(
      () => current,
      async () => {
        log.push("cookie");
        current = false; // teardown lands while the cookie is being written
      },
      () => log.push("open"),
      () => log.push("undo"),
    );
    expect(ok).toBe(false);
    expect(log).toEqual(["cookie", "undo"]);
  });

  it("openIfCurrent opens when the session survives", async () => {
    const log: string[] = [];
    expect(await openIfCurrent(() => true, async () => void log.push("c"), () => log.push("open"), () => log.push("undo"))).toBe(true);
    expect(log).toEqual(["c", "open"]);
  });
});

describe("SessionScope", () => {
  it("end() invalidates earlier jobs and aborts them; later jobs are current", () => {
    const s = new SessionScope();
    const a = s.begin();
    expect(a.isCurrent()).toBe(true);
    s.end();
    expect(a.isCurrent()).toBe(false);
    expect(a.signal.aborted).toBe(true);
    const b = s.begin();
    expect(b.isCurrent()).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });
});

describe("exclusive (single-flight setup slot)", () => {
  it("two rapid calls while the first awaits preflight: only one runs", async () => {
    const slot = new SetupSlot();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran = vi.fn();
    const work = async (handOff: () => void) => {
      await gate; // pending host probe
      ran();
      handOff();
      return "started";
    };
    const first = exclusive(slot, "busy", work);
    const second = exclusive(slot, "busy", work);
    expect(await second).toBe("busy");
    release();
    expect(await first).toBe("started");
    expect(ran).toHaveBeenCalledTimes(1);
    expect(slot.isBusy).toBe(true); // handed off: the background run owns it
    slot.release();
    expect(slot.isBusy).toBe(false);
  });

  it("releases the slot when work is refused or throws (never handed off)", async () => {
    const slot = new SetupSlot();
    expect(await exclusive(slot, "busy", async () => "refused")).toBe("refused");
    expect(slot.isBusy).toBe(false);
    await expect(exclusive(slot, "busy", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(slot.isBusy).toBe(false);
  });
});

describe("fetchBytes", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the body on success and throws on a non-2xx", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }));
    expect(Array.from(await fetchBytes("u", ok as unknown as typeof fetch))).toEqual([1, 2]);
    const bad = vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(fetchBytes("u", bad as unknown as typeof fetch)).rejects.toThrow("404");
  });

  it("a body that trickles forever is aborted at the deadline", async () => {
    vi.useFakeTimers();
    const stall = vi.fn(async (_u: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      arrayBuffer: () => new Promise<ArrayBuffer>((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
    }));
    const p = fetchBytes("https://x/y.tgz", stall as unknown as typeof fetch, 1000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ message: expect.stringContaining("timed out") });
  });
});
