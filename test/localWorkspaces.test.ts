import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/aw-test-userdata" } }));

import { fetchIdentityPublicKey, runtimeConfig, stepFor, toWorkspaceInfo } from "../src/main/localWorkspaces";
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
    expect(c.homesRoot).toBe("/ud/local-runtimes");
    expect(c.dataRoot).toBe("/Users/x/aw-workspaces");
    expect(c.path.startsWith("/Users/x/podman-dist/podman/bin:")).toBe(true);
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
