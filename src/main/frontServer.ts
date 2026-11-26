// Loopback front server for a standalone local workspace (card 41f5bf3b).
// The core serves no UI, so this serves the bundled SPA build and proxies
// /api/* and /ws/* (incl. a raw WebSocket upgrade tunnel) to 127.0.0.1:<apiPort>.
//
// Security (Mac spike: the core accepts ANY WebSocket Origin, even without a
// token), so this server is the only gate:
//  - bound to 127.0.0.1 only
//  - Host must be 127.0.0.1:<uiPort> or localhost:<uiPort>  (421 otherwise): blocks DNS rebinding
//  - WebSocket Origin must be exactly http://127.0.0.1:<uiPort> or http://localhost:<uiPort> (403 otherwise)
//  - Container-app windows (Tier-2: kali, code-server, ...) are served on `<app>.app.localhost:<uiPort>`
//    (strict label regex). Those Hosts proxy EVERY path, incl. WebSocket upgrades, to the core with the
//    Host header preserved (the core routes on Host(<app>.app.<host>)); the WebSocket Origin must be the same app host
//  - never injects or rewrites credentials: Cookie/Authorization pass through untouched
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createReadStream, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export interface FrontServerOptions {
  uiPort: number;
  apiPort: number;
  /** Directory holding the built SPA (index.html at its root). May be absent: static requests then 404. */
  staticDir: string;
}

export interface FrontServer {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

export const allowedHosts = (uiPort: number): string[] => [`127.0.0.1:${uiPort}`, `localhost:${uiPort}`];
export const allowedOrigins = (uiPort: number): string[] => [`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`];

/** `<app>.app.localhost:<uiPort>`: one DNS label for the app id, exact port, nothing else. */
export const appHostRe = (uiPort: number): RegExp => new RegExp(`^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.app\\.localhost:${uiPort}$`);

const isProxied = (path: string) => path === "/api" || path.startsWith("/api/") || path === "/ws" || path.startsWith("/ws/");

function rawReject(socket: Socket, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a URL pathname inside root; null when it escapes root or is malformed. */
export function resolveStatic(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const base = resolve(root);
  const full = resolve(base, "." + (decoded.startsWith("/") ? decoded : `/${decoded}`));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

export function createFrontServer(opts: FrontServerOptions): FrontServer {
  const hosts = new Set(allowedHosts(opts.uiPort));
  const origins = new Set(allowedOrigins(opts.uiPort));
  const upstreamHost = `127.0.0.1:${opts.apiPort}`;

  const appRe = appHostRe(opts.uiPort);
  const hostOf = (req: IncomingMessage) => (req.headers.host ?? "").toLowerCase();
  const isAppHost = (req: IncomingMessage) => appRe.test(hostOf(req));
  const hostOk = (req: IncomingMessage) => hosts.has(hostOf(req)) || isAppHost(req);
  const originOk = (req: IncomingMessage, origin: string) => {
    const o = origin.toLowerCase();
    if (origins.has(o)) return true;
    // An app window's own page (same app host) may open WebSockets back to itself.
    return isAppHost(req) && o === `http://${hostOf(req)}`;
  };

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed");
    const target = resolveStatic(opts.staticDir, pathname);
    if (!target) return sendText(res, 403, "forbidden");
    let file = target;
    if (!isFile(file)) {
      // SPA fallback for route-like paths only; a missing asset (has an extension) is a real 404.
      if (extname(pathname)) return sendText(res, 404, "not found");
      file = join(resolve(opts.staticDir), "index.html");
      if (!isFile(file)) return sendText(res, 404, "UI build not found");
    }
    const size = statSync(file).size;
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": size,
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  function proxyHttp(req: IncomingMessage, res: ServerResponse, keepHost = false): void {
    const up = httpRequest(
      { host: "127.0.0.1", port: opts.apiPort, method: req.method, path: req.url, headers: { ...req.headers, host: keepHost ? hostOf(req) : upstreamHost } },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) sendText(res, 502, "workspace unavailable");
      else res.destroy();
    });
    req.pipe(up);
  }

  const server = createServer((req, res) => {
    if (!hostOk(req)) return sendText(res, 421, "misdirected request");
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (isAppHost(req)) return proxyHttp(req, res, true);
    if (isProxied(pathname)) return proxyHttp(req, res);
    serveStatic(req, res, pathname);
  });

  // Upgraded sockets are detached from the http server, so track every socket to tear them down on close.
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if (!hostOk(req)) return rawReject(socket, 421, "Misdirected Request");
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !originOk(req, origin)) return rawReject(socket, 403, "Forbidden");
    const appHost = isAppHost(req);
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (!appHost && !isProxied(pathname)) return rawReject(socket, 404, "Not Found");

    const up = httpRequest({
      host: "127.0.0.1",
      port: opts.apiPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: appHost ? hostOf(req) : upstreamHost },
    });
    up.on("upgrade", (ur, usock, uhead) => {
      let out = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`;
      for (let i = 0; i < ur.rawHeaders.length; i += 2) out += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
      socket.write(out + "\r\n");
      if (uhead.length) socket.write(uhead);
      if (head.length) usock.write(head);
      usock.pipe(socket);
      socket.pipe(usock);
      usock.on("error", () => socket.destroy());
      socket.on("close", () => usock.destroy());
      usock.on("close", () => socket.destroy());
    });
    // Upstream answered without upgrading (e.g. 401/404): relay that status and close.
    up.on("response", (ur) => {
      socket.end(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      ur.resume();
    });
    up.on("error", () => rawReject(socket, 502, "Bad Gateway"));
    up.end();
  });

  return {
    server,
    listen: () =>
      new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(opts.uiPort, "127.0.0.1", () => {
          server.off("error", rej);
          res();
        });
      }),
    close: () =>
      new Promise((res) => {
        server.close(() => res());
        for (const s of sockets) s.destroy();
      }),
  };
}
