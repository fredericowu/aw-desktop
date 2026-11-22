// Start (and stop) an EXISTING local workspace with the real LocalRuntime and the engine bundled in a
// given app copy, using the workspace's real HOME/data dirs, the same config the app builds
// (runtimeConfig). Proves an existing VM created by an older engine starts with the bundled one.
// Bundle: npx esbuild e2e/phaseE/driveExisting.ts --bundle --platform=node --format=esm --outfile=<out>/driveExisting.mjs
// Usage: node driveExisting.mjs <up|stop> <localWorkspaceId>   (env AW_DESKTOP_ENGINE_DIR=<app>/Contents/Resources/engine)
import { LocalRuntime } from "../../src/main/localRuntime";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [cmd, id] = process.argv.slice(2);
const home = process.env.HOME ?? "";
const engine = process.env.AW_DESKTOP_ENGINE_DIR ?? "";
if (!engine || !id) throw new Error("usage: AW_DESKTOP_ENGINE_DIR=... node driveExisting.mjs <up|stop> <id>");
const ud = process.env.AW_E2E_USER_DATA ?? join(home, "Library/Application Support/aw-desktop");
const podman = join(engine, "bin/podman");
const rt = new LocalRuntime({
  podmanPath: podman,
  homesRoot: join(home, ".awd"),
  dataRoot: join(home, "aw-workspaces"),
  path: `${dirname(podman)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  arch: process.arch,
});
const reg = JSON.parse(readFileSync(join(ud, "local-workspaces.json"), "utf8")) as { workspaces: { id: string }[] };
const ws = reg.workspaces.find((w) => w.id === id) as never;
if (!ws) throw new Error(`no workspace ${id} in the registry`);
const t0 = Date.now();
const log = (m: string) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
if (cmd === "up") {
  await rt.start(ws, { authPublicKey: readFileSync(join(ud, "identity-public-key.pem"), "utf8"), onStep: (s) => log("step " + s) });
  log("READY");
} else if (cmd === "stop") {
  await rt.stop(id);
  log("stopped");
}
