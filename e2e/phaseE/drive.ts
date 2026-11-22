// Phase E driver: runs the REAL LocalRuntime + frontServer against real podman (no electron).
// Bundle first (see README): npx esbuild e2e/phaseE/drive.ts --bundle --platform=node --format=esm --outfile=<out>/drive.mjs
// Usage: node drive.mjs <up|stop|destroy> <root> <id> <apiPort> <uiPort> <uiDir> [pubkeyFile]
import { LocalRuntime } from "../../src/main/localRuntime";
import { createFrontServer } from "../../src/main/frontServer";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const [cmd, root, id, api, ui, uiDir, keyFile] = process.argv.slice(2);
const podman = process.env.AW_E2E_PODMAN ?? join(process.env.AW_DESKTOP_ENGINE_DIR ?? join(process.env.AW_E2E_APP ?? "/Applications/AW Desktop.app", "Contents", "Resources", "engine"), "bin", "podman");
const rt = new LocalRuntime({
  podmanPath: podman,
  homesRoot: join(root, "local-runtimes"),
  dataRoot: join(root, "aw-workspaces"),
  tmpRoot: "/tmp",
  path: `${dirname(podman)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  arch: process.arch,
});
const ws = { id, name: id, sub: "e2e", uiPort: Number(ui), apiPort: Number(api), createdAt: new Date().toISOString(), cloud: "none" as const };
const t0 = Date.now();
const log = (m: string) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
if (cmd === "up") {
  await rt.start(ws, { authPublicKey: keyFile ? readFileSync(keyFile, "utf8") : undefined, onStep: (s) => log("step " + s) });
  const front = createFrontServer({ uiPort: ws.uiPort, apiPort: ws.apiPort, staticDir: uiDir });
  await front.listen();
  log("FRONT listening " + ws.uiPort + "; READY");
  const bye = async () => { await front.close(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
  setInterval(() => {}, 1 << 30);
} else if (cmd === "stop") { await rt.stop(id); log("stopped"); }
else if (cmd === "destroy") { await rt.destroy(id); log("destroyed"); }
