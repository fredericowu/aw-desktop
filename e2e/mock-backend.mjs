// Mock aw-backend + workspace host for driving the REAL packaged AW Desktop app.
// Usage: node mock-backend.mjs <port> <cert.pem> <key.pem> <log.jsonl>
// App side: AW_DESKTOP_APEX=<ip>.nip.io:<port> NODE_TLS_REJECT_UNAUTHORIZED=0
// Control: POST /__ctl {"logoutHang":true|false}; GET /__log
import https from "node:https";
import { readFileSync, appendFileSync } from "node:fs";

const [port, cert, key, logFile] = process.argv.slice(2);
const ctl = { logoutHang: false };
const user = {
  id: 1, email: "e2e@example.invalid", is_active: true, platform_role: null,
  is_aw_owner: false, glasses_workspace: null, memberships: [{ workspace: "mock-cloud", role: "owner" }],
};
const j = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const host = req.headers.host ?? "";
    const entry = { t: Date.now(), m: req.method, u: req.url, host };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
    if (host.includes(".workspace.")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body style='font:20px sans-serif;padding:40px'><h1>Mock workspace shell</h1><p>" + host + "</p></body></html>");
    }
    const p = req.url.split("?")[0];
    if (p === "/__ctl") { Object.assign(ctl, JSON.parse(raw || "{}")); return j(res, 200, ctl); }
    if (p === "/__log") { res.writeHead(200); return res.end(readFileSync(logFile)); }
    if (p === "/api/identity/login") {
      const b = JSON.parse(raw || "{}");
      return b.password === "wrong" ? j(res, 401, { error: "invalid_credentials" }) : j(res, 200, { token: "mock-token", user });
    }
    if (p === "/api/identity/google/exchange") return j(res, 200, { token: "mock-token", user });
    if (p === "/api/identity/me") return j(res, 200, user);
    if (p === "/api/identity/refresh") return j(res, 200, { token: "mock-token", user });
    if (p === "/api/identity/logout") { if (ctl.logoutHang) return; return j(res, 200, {}); }
    if (p === "/api/workspaces" && req.method === "GET")
      return j(res, 200, { workspaces: [{ name: "mock-cloud", placement_driver: "docker", is_hosted: true, status: "running" }] });
    if (p === "/api/accounts/me") return j(res, 200, { limits: { max_workspaces: 3, max_local_workspaces: 1 }, local_count: 0 });
    j(res, 404, { error: "not_mocked", path: p });
  });
}).listen(Number(port), "127.0.0.1", () => console.log("mock up", port));
