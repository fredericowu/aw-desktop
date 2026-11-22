import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/aw-test-userdata" } }));

import { LocalWorkspaces, fetchIdentityPublicKey, runtimeConfig, stepFor, toWorkspaceInfo } from "../src/main/localWorkspaces";
import { LocalRegistry, fileStore } from "../src/main/localRegistry";
import { LocalRuntime } from "../src/main/localRuntime";
import { isAllowedTarget } from "../src/main/navPolicy";
import { isLocal } from "../src/shared/workspaces";

const rec = { id: "local7f3a9c", name: "My box", sub: "42", uiPort: 9031, apiPort: 9032, createdAt: "x", cloud: "none" as const };

describe("local workspace view", () => {
  it("maps registry records to picker rows: id is the slug, name is the display name, placement is local", () => {
    const row = toWorkspaceInfo(rec, false);
    expect(row).toMatchObject({ name: "local7f3a9c", display_name: "My box", status: "stopped", is_hosted: false });
    expect(isLocal(row)).toBe(true);
    expect(toWorkspaceInfo(rec, true).status).toBe("running");
  });

  it("maps runtime steps to progress steps; health and running both end at 'running'", () => {
    expect(["machine", "image", "postgres", "redis", "workspace", "health", "running"].map(stepFor)).toEqual([
      "machine", "image", "postgres", "redis", "workspace", "running", "running",
    ]);
  });

  it("runtime config uses the vendored podman, app-private homes and ~/aw-workspaces, never the default machine home", () => {
    const c = runtimeConfig("/ud", "/Users/x");
    expect(c.podmanPath).toBe("/Users/x/podman-dist/podman/bin/podman");
    expect(c.homesRoot).toBe("/Users/x/.awd");
    expect(c.dataRoot).toBe("/Users/x/aw-workspaces");
    expect(c.path.startsWith("/Users/x/podman-dist/podman/bin:")).toBe(true);
  });
});

describe("podman unix socket path length", () => {
  it("keeps <home>/.podman/aw-<id>-ignition.sock within macOS's 103-byte sun_path limit", () => {
    // id is "local" + 6 hex; a 20-char username is already longer than typical.
    const home = "/Users/abcdefghijklmnopqrst";
    const c = runtimeConfig(`${home}/Library/Application Support/aw-desktop`, home);
    const sock = `${c.homesRoot}/localf7823d/home/.podman/aw-localf7823d-ignition.sock`;
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(103);
  });
});

describe("identity public key", () => {
  const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
  it("returns a trimmed PEM", async () => {
    expect(await fetchIdentityPublicKey((async () => new Response(`${pem}\n`)) as typeof fetch)).toBe(pem);
  });
  it("rejects a non-PEM body and a non-200", async () => {
    await expect(fetchIdentityPublicKey((async () => new Response("<html>")) as typeof fetch)).rejects.toThrow(/PEM/);
    await expect(fetchIdentityPublicKey((async () => new Response("no", { status: 500 })) as typeof fetch)).rejects.toThrow(/500/);
  });
});

describe("shell window navigation policy", () => {
  it("a local window allows its own loopback origin only", () => {
    const o = "http://127.0.0.1:9031";
    expect(isAllowedTarget("http://127.0.0.1:9031/some/route", o)).toBe(true);
    expect(isAllowedTarget("http://127.0.0.1:9030/", o)).toBe(false);
    expect(isAllowedTarget("http://127.0.0.1:9031/", undefined)).toBe(false);
    expect(isAllowedTarget("https://evil.example/", o)).toBe(false);
  });
  it("still allows the apex and its subdomains", () => {
    expect(isAllowedTarget("https://acme.workspace.aw.tekflox.com/x")).toBe(true);
  });
});

describe("LocalWorkspaces.destroy", () => {
  it("removes the dirs and the registry entry, frees the ports, and leaves the other workspace alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "awd-destroy-"));
    const cfg = { podmanPath: "/p", homesRoot: join(root, ".awd"), dataRoot: join(root, "aw-workspaces"), tmpRoot: join(root, "tmp"), path: "/bin" };
    const lw = new LocalWorkspaces(() => null, async () => undefined);
    let n = 0;
    const registry = new LocalRegistry({ store: fileStore(join(root, "reg.json")), isPortFree: async () => true, newId: () => `local${++n}` });
    const calls: string[] = [];
    const runtime = new LocalRuntime(cfg, { run: async (_c, args) => (calls.push(args.join(" ")), { code: 0, stdout: "", stderr: "" }) });
    Object.assign(lw, { registry, runtime });
    const a = await registry.create("s", "A");
    const b = await registry.create("s", "B");
    for (const w of [a, b]) {
      runtime.prepare(w.id);
      writeFileSync(join(cfg.dataRoot, w.id, "postgres", "f"), "x");
    }
    expect(registry.listFor("s")).toHaveLength(2);

    await lw.destroy(a.id);

    expect(registry.get(a.id)).toBeUndefined();
    expect(registry.listFor("s").map((w) => w.id)).toEqual([b.id]);
    for (const d of [join(cfg.dataRoot, a.id), join(cfg.homesRoot, a.id), join(cfg.tmpRoot, `aw-${a.id}`)]) expect(existsSync(d)).toBe(false);
    for (const d of [join(cfg.dataRoot, b.id), join(cfg.homesRoot, b.id), join(cfg.tmpRoot, `aw-${b.id}`)]) expect(existsSync(d)).toBe(true);
    // ports released: a new workspace can take A's pair again
    const c = await registry.create("s", "C");
    expect([c.uiPort, c.apiPort]).toEqual([a.uiPort, a.apiPort]);
    expect(calls.every((x) => !x.includes(b.id))).toBe(true);
  });

  it("keeps the registry entry when cleanup fails so the user can retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "awd-destroy-"));
    const cfg = { podmanPath: "/p", homesRoot: join(root, ".awd"), dataRoot: join(root, "d"), tmpRoot: join(root, "t"), path: "/bin" };
    const lw = new LocalWorkspaces(() => null, async () => undefined);
    const registry = new LocalRegistry({ store: fileStore(join(root, "reg.json")), isPortFree: async () => true, newId: () => "localx" });
    // `machine list` keeps reporting the machine, so removal can never be confirmed
    const runtime = new LocalRuntime(cfg, { run: async (_c, args) => ({ code: 0, stdout: args.includes("list") ? "aw-localx*\n" : "", stderr: "" }) });
    Object.assign(lw, { registry, runtime });
    const w = await registry.create("s", "X");
    await expect(lw.destroy(w.id)).rejects.toThrow();
    expect(registry.get(w.id)).toBeDefined();
  });
  it("removes a workspace whose bootstrap failed before any VM (podman binary missing), real fs + default runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "awd-destroy-"));
    const cfg = { podmanPath: join(root, "missing-podman"), homesRoot: join(root, ".awd"), dataRoot: join(root, "d"), tmpRoot: join(root, "t"), path: "/bin" };
    const lw = new LocalWorkspaces(() => null, async () => undefined);
    const registry = new LocalRegistry({ store: fileStore(join(root, "reg.json")), isPortFree: async () => true, newId: () => "localy" });
    const runtime = new LocalRuntime(cfg);
    Object.assign(lw, { registry, runtime });
    const w = await registry.create("s", "Y");
    runtime.prepare(w.id);
    await lw.destroy(w.id);
    expect(registry.get(w.id)).toBeUndefined();
    for (const d of [join(cfg.dataRoot, w.id), join(cfg.homesRoot, w.id), join(cfg.tmpRoot, `aw-${w.id}`)]) expect(existsSync(d)).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)("keeps data and registry when a machine artifact path is unreadable (EACCES), real fs + default runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "awd-destroy-"));
    const cfg = { podmanPath: join(root, "missing-podman"), homesRoot: join(root, ".awd"), dataRoot: join(root, "d"), tmpRoot: join(root, "t"), path: "/bin" };
    const lw = new LocalWorkspaces(() => null, async () => undefined);
    const registry = new LocalRegistry({ store: fileStore(join(root, "reg.json")), isPortFree: async () => true, newId: () => "localz" });
    const runtime = new LocalRuntime(cfg);
    Object.assign(lw, { registry, runtime });
    const w = await registry.create("s", "Z");
    runtime.prepare(w.id);
    const anc = join(cfg.homesRoot, w.id, "home", ".local", "share", "containers");
    mkdirSync(join(anc, "podman", "machine"), { recursive: true });
    writeFileSync(join(anc, "podman", "machine", "machine.json"), "{}");
    chmodSync(anc, 0o600);
    try {
      await expect(lw.destroy(w.id)).rejects.toThrow();
      expect(registry.get(w.id)).toBeDefined();
      for (const d of [join(cfg.dataRoot, w.id), join(cfg.homesRoot, w.id), join(cfg.tmpRoot, `aw-${w.id}`)]) expect(existsSync(d)).toBe(true);
    } finally {
      chmodSync(anc, 0o700);
    }
  });
});
