import { afterEach, describe, expect, it, vi } from "vitest";
import { accountMe, ApiError, createWorkspace, listWorkspaces, mintBootstrapToken, REQUEST_TIMEOUT_MS } from "../src/main/apiClient";

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

describe("request deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("a token POST whose body stalls after headers rejects instead of hanging", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          // headers arrived; the body never completes unless the request is aborted
          json: () =>
            new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
        }),
      ),
    );
    const p = mintBootstrapToken("tok", "w").catch((e) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ message: "request_timed_out" });
  });

  it("a request that never answers at all also times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))),
    );
    const p = createWorkspace("tok", "w").catch((e) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ message: "request_timed_out" });
  });
});
