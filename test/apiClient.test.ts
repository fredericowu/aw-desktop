import { afterEach, describe, expect, it, vi } from "vitest";
import { accountMe, ApiError, createWorkspace, listWorkspaces } from "../src/main/apiClient";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("authed workspace calls", () => {
  it("createWorkspace posts remote-host with a bearer token", async () => {
    const fn = mockFetch(200, { name: "w1", status: "provisioning" });
    await createWorkspace("tok", "w1");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/workspaces$/);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ name: "w1", placement_driver: "remote-host" });
  });

  it("surfaces the error code, status and limit on a 402", async () => {
    mockFetch(402, { error: "plan_limit_local_workspaces", limit: 2, message: "Your plan allows 2 local workspace(s)." });
    const err = await createWorkspace("tok", "w3").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 402,
      code: "plan_limit_local_workspaces",
      limit: 2,
      message: "Your plan allows 2 local workspace(s).",
    });
  });

  it("listWorkspaces unwraps {workspaces}", async () => {
    mockFetch(200, { workspaces: [{ name: "a" }] });
    expect(await listWorkspaces("tok")).toEqual([{ name: "a" }]);
  });

  it("accountMe returns limits + local_count", async () => {
    mockFetch(200, { limits: { max_local_workspaces: 2 }, local_count: 1 });
    expect(await accountMe("tok")).toMatchObject({ local_count: 1 });
  });
});
