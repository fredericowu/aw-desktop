import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFrontServer, resolveStatic, type FrontServer } from "../src/main/frontServer";

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

interface Resp { status: number; headers: IncomingHttpHeaders; body: string }
function get(port: number, path: string, opts: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
      },
    );
    r.on("error", reject);
    r.end(opts.body);
  });
}

/** Attempt a WS-style upgrade; resolves with the status line or the upgraded socket echoing. */
function upgrade(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; echo?: string }> {
  return new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { connection: "Upgrade", upgrade: "websocket", host: `127.0.0.1:${port}`, ...headers } });
    r.on("upgrade", (res, sock) => {
      sock.write("ping");
      sock.once("data", (d) => {
        sock.destroy();
        resolve({ status: res.statusCode ?? 0, echo: d.toString() });
      });
    });
    r.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    r.on("error", () => resolve({ status: 0 }));
    r.end();
  });
}

let upstream: Server;
let seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string; upgraded: number };
let apiPort: number;
let uiPort: number;
let front: FrontServer;
let dir: string;
const upSocks = new Set<import("node:net").Socket>();

beforeAll(async () => {
  seen = { headers: {}, body: "", upgraded: 0 };
  upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen = { ...seen, method: req.method, url: req.url, headers: req.headers, body: b };
      res.writeHead(201, { "content-type": "application/json", "x-up": "1" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.on("upgrade", (req, sock) => {
    seen.upgraded++;
    upSocks.add(sock);
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (d) => sock.write(d)); // echo
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  apiPort = (upstream.address() as { port: number }).port;
  uiPort = await freePort();
  dir = mkdtempSync(join(tmpdir(), "front-"));
  mkdirSync(join(dir, "ui", "assets"), { recursive: true });
  writeFileSync(join(dir, "ui", "index.html"), "<html>SPA</html>");
  writeFileSync(join(dir, "ui", "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "TOP-SECRET");
  front = createFrontServer({ uiPort, apiPort, staticDir: join(dir, "ui") });
  await front.listen();
});
afterAll(async () => {
  await front.close();
  upstream.closeAllConnections();
  for (const s of upSocks) s.destroy();
  await new Promise((r) => upstream.close(r));
});

describe("host check", () => {
  it("accepts 127.0.0.1:<ui> and localhost:<ui>", async () => {
    expect((await get(uiPort, "/")).status).toBe(200);
    expect((await get(uiPort, "/", { host: `localhost:${uiPort}` })).status).toBe(200);
  });
  it.each(["evil.example.com", "evil.example.com:80", "127.0.0.1", "127.0.0.1:9999", "localhost", "127.0.0.1.evil.com"])("rejects Host %s with 421", async (h) => {
    expect((await get(uiPort, "/", { host: h })).status).toBe(421);
    expect((await get(uiPort, "/api/x", { host: h })).status).toBe(421);
  });
  it("also 421s an upgrade with a bad Host", async () => {
    expect((await upgrade(uiPort, "/ws/x", { host: "evil.com", origin: `http://127.0.0.1:${uiPort}` })).status).toBe(421);
  });
  it("is bound to loopback only", () => {
    expect((front.server.address() as { address: string }).address).toBe("127.0.0.1");
  });
});

describe("proxy", () => {
  it("forwards method, path, body and status; passes credentials through untouched and adds none", async () => {
    const r = await get(uiPort, "/api/things?a=1", {
      method: "POST",
      body: "payload",
      headers: { cookie: "aw_id_jwt=abc", "content-type": "text/plain" },
    });
    expect(r.status).toBe(201);
    expect(r.headers["x-up"]).toBe("1");
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/things?a=1");
    expect(seen.body).toBe("payload");
    expect(seen.headers.cookie).toBe("aw_id_jwt=abc");
    expect(seen.headers.host).toBe(`127.0.0.1:${apiPort}`);
    await get(uiPort, "/api/y");
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
  });
  it("502s when the upstream is down", async () => {
    const p = await freePort();
    const dead = createFrontServer({ uiPort: await freePort(), apiPort: p, staticDir: dir });
    await dead.listen();
    const port = (dead.server.address() as { port: number }).port;
    expect((await get(port, "/api/x")).status).toBe(502);
    await dead.close();
  });
});

describe("websocket", () => {
  it("tunnels an upgrade with an allowed Origin (127.0.0.1 and localhost) and echoes", async () => {
    for (const o of [`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`]) {
      const r = await upgrade(uiPort, "/ws/terminal", { origin: o });
      expect(r).toEqual({ status: 101, echo: "ping" });
    }
  });
  it("rejects a missing Origin with 403 and never reaches upstream", async () => {
    const before = seen.upgraded;
    expect((await upgrade(uiPort, "/ws/terminal", {})).status).toBe(403);
    expect(seen.upgraded).toBe(before);
  });
  it.each(["http://evil.com", `http://127.0.0.1:${1}`, "https://127.0.0.1", "null", "http://127.0.0.1.evil.com"])("rejects Origin %s with 403", async (o) => {
    const before = seen.upgraded;
    expect((await upgrade(uiPort, "/ws/terminal", { origin: o })).status).toBe(403);
    expect(seen.upgraded).toBe(before);
  });
  it("only upgrades /ws and /api paths", async () => {
    expect((await upgrade(uiPort, "/other", { origin: `http://127.0.0.1:${uiPort}` })).status).toBe(404);
  });
});

describe("static", () => {
  it("serves files with a content type", async () => {
    const r = await get(uiPort, "/assets/app.js");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("javascript");
    expect(r.body).toBe("console.log(1)");
  });
  it("SPA fallback for route-like paths, 404 for missing assets", async () => {
    expect((await get(uiPort, "/some/route")).body).toBe("<html>SPA</html>");
    expect((await get(uiPort, "/missing.js")).status).toBe(404);
  });
  it("blocks path traversal (raw, encoded, double-encoded stays literal)", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt", "/%5c..%5csecret.txt", "/%00"]) {
      const r = await get(uiPort, p);
      expect(r.body).not.toContain("TOP-SECRET");
      expect([200, 400, 403, 404]).toContain(r.status);
    }
    expect([403, 404]).toContain((await get(uiPort, "/%2e%2e/secret.txt")).status);
  });
  it("resolveStatic stays inside the root", () => {
    expect(resolveStatic("/r", "/a/b.js")).toBe("/r/a/b.js");
    expect(resolveStatic("/r", "/../x")).toBeNull();
    expect(resolveStatic("/r", "/a/../../x")).toBeNull();
    expect(resolveStatic("/r", "/%E0%A4%A")).toBeNull();
  });
  it("405 for non-GET static requests", async () => {
    expect((await get(uiPort, "/", { method: "POST" })).status).toBe(405);
  });
});
