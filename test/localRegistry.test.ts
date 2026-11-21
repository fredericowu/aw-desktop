import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalLimitReachedError,
  LocalRegistry,
  allocatePorts,
  fileStore,
  findFreePort,
  probeLoopbackPort,
  type RegistryStore,
} from "../src/main/localRegistry";

function memStore(): RegistryStore & { data: string | null } {
  const s = {
    data: null as string | null,
    read: () => s.data,
    write: (d: string) => {
      s.data = d;
    },
  };
  return s;
}
const freeExcept = (busy: number[]) => async (p: number) => !busy.includes(p);
let n = 0;
const mk = (store: RegistryStore, extra: Partial<ConstructorParameters<typeof LocalRegistry>[0]> = {}) =>
  new LocalRegistry({ store, isPortFree: freeExcept([]), newId: () => `local00000${n++}`, ...extra });

describe("port allocation", () => {
  it("starts at 9031 and assigns two distinct ports", async () => {
    expect(await allocatePorts(freeExcept([]), new Set())).toEqual({ uiPort: 9031, apiPort: 9032 });
  });
  it("bumps past busy ports", async () => {
    expect(await allocatePorts(freeExcept([9031, 9033]), new Set())).toEqual({ uiPort: 9032, apiPort: 9034 });
  });
  it("never returns 9030 even when asked to start there", async () => {
    expect(await findFreePort(freeExcept([]), new Set(), 9000)).toBe(9031);
  });
  it("skips ports already persisted for other workspaces", async () => {
    expect(await allocatePorts(freeExcept([]), new Set([9031, 9032]))).toEqual({ uiPort: 9033, apiPort: 9034 });
  });
  it("real probe sees a bound loopback port as busy", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    expect(await probeLoopbackPort(port)).toBe(false);
    await new Promise((r) => srv.close(r));
    expect(await probeLoopbackPort(port)).toBe(true);
  });
});

describe("registry persistence", () => {
  it("persists records with cloud none and reloads them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const path = join(dir, "sub", "local-workspaces.json");
    const a = await mk(fileStore(path)).create("subA", "Home");
    const again = new LocalRegistry({ store: fileStore(path) }).list();
    expect(again).toEqual([a]);
    expect(a).toMatchObject({ name: "Home", sub: "subA", uiPort: 9031, apiPort: 9032, cloud: "none" });
    expect(a.id).toMatch(/^local[a-z0-9]+$/);
  });
  it("second workspace gets different ports; remove frees the record", async () => {
    const s = memStore();
    const r = mk(s, { fetchMaxLocal: async () => 5 });
    const a = await r.create("subA", "a");
    const b = await r.create("subA", "b");
    expect(new Set([a.uiPort, a.apiPort, b.uiPort, b.apiPort]).size).toBe(4);
    expect(r.remove(a.id)).toBe(true);
    expect(r.list().map((w) => w.id)).toEqual([b.id]);
    expect(r.remove("nope")).toBe(false);
  });
  it("tolerates a corrupt file", () => {
    const s = memStore();
    s.data = "{not json";
    expect(mk(s).list()).toEqual([]);
  });
});

describe("cap", () => {
  it("throws LocalLimitReachedError at the backend limit", async () => {
    const r = mk(memStore(), { fetchMaxLocal: async () => 2 });
    await r.create("subA", "a");
    await r.create("subA", "b");
    const err = await r.create("subA", "c").catch((e) => e);
    expect(err).toBeInstanceOf(LocalLimitReachedError);
    expect(err).toMatchObject({ limit: 2, count: 2, code: "local_limit_reached" });
  });
  it("uses a raised limit from the backend", async () => {
    const r = mk(memStore(), { fetchMaxLocal: async () => 3 });
    for (const x of ["a", "b", "c"]) await r.create("subA", x);
    await expect(r.create("subA", "d")).rejects.toBeInstanceOf(LocalLimitReachedError);
  });
  it("uses the cached last-known limit when offline", async () => {
    const s = memStore();
    await mk(s, { fetchMaxLocal: async () => 1 }).resolveLimit("subA");
    const offline = mk(s, {
      fetchMaxLocal: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await offline.resolveLimit("subA")).toBe(1);
    await offline.create("subA", "a");
    await expect(offline.create("subA", "b")).rejects.toBeInstanceOf(LocalLimitReachedError);
  });
  it("falls back to 2 with no cache and no backend value", async () => {
    expect(await mk(memStore(), { fetchMaxLocal: async () => undefined }).resolveLimit("subA")).toBe(2);
    expect(await mk(memStore()).resolveLimit("subA")).toBe(2);
  });
});

describe("per-account cap", () => {
  it("counts only the signed-in sub's records on a shared store", async () => {
    const s = memStore();
    const a = mk(s, { fetchMaxLocal: async () => 2 });
    await a.create("subA", "a1");
    await a.create("subA", "a2");
    await expect(a.create("subA", "a3")).rejects.toBeInstanceOf(LocalLimitReachedError);
    const b = mk(s, { fetchMaxLocal: async () => 1 });
    const ws = await b.create("subB", "b1");
    expect(ws.sub).toBe("subB");
    expect(b.listFor("subA")).toHaveLength(2);
    expect(b.listFor("subB")).toHaveLength(1);
    const err = await b.create("subB", "b2").catch((e) => e);
    expect(err).toMatchObject({ limit: 1, count: 1 });
  });
  it("caches the limit per sub for offline use", async () => {
    const s = memStore();
    await mk(s, { fetchMaxLocal: async () => 5 }).resolveLimit("subA");
    await mk(s, { fetchMaxLocal: async () => 1 }).resolveLimit("subB");
    const offline = mk(s, {
      fetchMaxLocal: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await offline.resolveLimit("subA")).toBe(5);
    expect(await offline.resolveLimit("subB")).toBe(1);
    expect(await offline.resolveLimit("subC")).toBe(2);
  });
  it("keeps both limits when refreshes for two subs overlap", async () => {
    const s = memStore();
    const r = mk(s, { fetchMaxLocal: async (sub) => (await Promise.resolve(), sub === "A" ? 5 : 1) });
    await Promise.all([r.resolveLimit("A"), r.resolveLimit("B")]);
    const offline = mk(s, { fetchMaxLocal: async () => { throw new Error("offline"); } });
    expect(await offline.resolveLimit("A")).toBe(5);
    expect(await offline.resolveLimit("B")).toBe(1);
  });
  it("keeps another account's refreshed limit when a create is blocked on the port probe", async () => {
    const s = memStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const probing = new Promise<void>((r) => (reached = r));
    const creator = mk(s, {
      fetchMaxLocal: async () => 5,
      isPortFree: async () => (reached(), await gate, true),
    });
    const pending = creator.create("A", "pending");
    await probing;
    await mk(s, { fetchMaxLocal: async () => 5 }).resolveLimit("B");
    release();
    const ws = await pending;
    const offline = mk(s, { fetchMaxLocal: async () => { throw new Error("offline"); } });
    expect(await offline.resolveLimit("B")).toBe(5);
    expect(offline.list().map((w) => w.id)).toEqual([ws.id]);
  });
  it("never hands the same ports to two overlapping creates", async () => {
    const s = memStore();
    const r = mk(s, { fetchMaxLocal: async () => 5, isPortFree: async () => (await Promise.resolve(), true) });
    const [a, b] = await Promise.all([r.create("A", "a"), r.create("B", "b")]);
    const ports = [a.uiPort, a.apiPort, b.uiPort, b.apiPort];
    expect(new Set(ports).size).toBe(4);
    expect(r.list()).toHaveLength(2);
  });
  it("keeps a workspace created while a refresh is in flight", async () => {
    const s = memStore();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = mk(s, { fetchMaxLocal: async () => 3 });
    await r.create("A", "first");
    const slow = mk(s, { fetchMaxLocal: async () => (await gate, 4) });
    const pending = slow.resolveLimit("A");
    await r.create("A", "second");
    release();
    expect(await pending).toBe(4);
    expect(r.listFor("A")).toHaveLength(2);
  });
  it("passes the sub to the limit fetch and rejects an empty sub", async () => {
    const seen: string[] = [];
    const r = mk(memStore(), { fetchMaxLocal: async (sub) => (seen.push(sub), 3) });
    await r.create("subA", "a");
    expect(seen).toEqual(["subA"]);
    await expect(r.create("", "x")).rejects.toThrow(/sub is required/);
  });
});

describe("reconcilePorts", () => {
  it("keeps free ports, bumps busy ones, persists the bump", async () => {
    const s = memStore();
    const r = mk(s);
    const ws = await r.create("subA", "a");
    expect(await r.reconcilePorts(ws.id)).toMatchObject({ uiChanged: false, apiChanged: false });
    const busy = new LocalRegistry({ store: s, isPortFree: freeExcept([ws.uiPort]) });
    const res = await busy.reconcilePorts(ws.id);
    expect(res.uiChanged).toBe(true);
    expect(res.workspace.uiPort).not.toBe(ws.uiPort);
    expect(res.workspace.uiPort).not.toBe(res.workspace.apiPort);
    expect(busy.get(ws.id)?.uiPort).toBe(res.workspace.uiPort);
  });
  it("a port held by our own container is not bumped", async () => {
    const s = memStore();
    const ws = await mk(s).create("subA", "a");
    const r = new LocalRegistry({ store: s, isPortFree: freeExcept([ws.apiPort]) });
    expect((await r.reconcilePorts(ws.id, (p) => p === ws.apiPort)).apiChanged).toBe(false);
  });
  it("concurrent reconciles of two workspaces persist four distinct ports", async () => {
    const s = memStore();
    const base = mk(s, { fetchMaxLocal: async () => 5 });
    const a = await base.create("A", "a");
    const b = await base.create("A", "b");
    const busy = [a.uiPort, b.uiPort];
    const isPortFree = async (p: number) => (await Promise.resolve(), !busy.includes(p));
    const r1 = new LocalRegistry({ store: s, isPortFree });
    const r2 = new LocalRegistry({ store: s, isPortFree });
    await Promise.all([r1.reconcilePorts(a.id), r2.reconcilePorts(b.id)]);
    const all = r1.list().flatMap((w) => [w.uiPort, w.apiPort]);
    expect(new Set(all).size).toBe(4);
  });
});
