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
    const a = await mk(fileStore(path)).create("Home");
    const again = new LocalRegistry({ store: fileStore(path) }).list();
    expect(again).toEqual([a]);
    expect(a).toMatchObject({ name: "Home", uiPort: 9031, apiPort: 9032, cloud: "none" });
    expect(a.id).toMatch(/^local[a-z0-9]+$/);
  });
  it("second workspace gets different ports; remove frees the record", async () => {
    const s = memStore();
    const r = mk(s, { fetchMaxLocal: async () => 5 });
    const a = await r.create("a");
    const b = await r.create("b");
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
    await r.create("a");
    await r.create("b");
    const err = await r.create("c").catch((e) => e);
    expect(err).toBeInstanceOf(LocalLimitReachedError);
    expect(err).toMatchObject({ limit: 2, count: 2, code: "local_limit_reached" });
  });
  it("uses a raised limit from the backend", async () => {
    const r = mk(memStore(), { fetchMaxLocal: async () => 3 });
    for (const x of ["a", "b", "c"]) await r.create(x);
    await expect(r.create("d")).rejects.toBeInstanceOf(LocalLimitReachedError);
  });
  it("uses the cached last-known limit when offline", async () => {
    const s = memStore();
    await mk(s, { fetchMaxLocal: async () => 1 }).resolveLimit();
    const offline = mk(s, {
      fetchMaxLocal: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await offline.resolveLimit()).toBe(1);
    await offline.create("a");
    await expect(offline.create("b")).rejects.toBeInstanceOf(LocalLimitReachedError);
  });
  it("falls back to 2 with no cache and no backend value", async () => {
    expect(await mk(memStore(), { fetchMaxLocal: async () => undefined }).resolveLimit()).toBe(2);
    expect(await mk(memStore()).resolveLimit()).toBe(2);
  });
});

describe("reconcilePorts", () => {
  it("keeps free ports, bumps busy ones, persists the bump", async () => {
    const s = memStore();
    const r = mk(s);
    const ws = await r.create("a");
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
    const ws = await mk(s).create("a");
    const r = new LocalRegistry({ store: s, isPortFree: freeExcept([ws.apiPort]) });
    expect((await r.reconcilePorts(ws.id, (p) => p === ws.apiPort)).apiChanged).toBe(false);
  });
});
