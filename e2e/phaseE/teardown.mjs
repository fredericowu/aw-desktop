// Teardown + leftovers checks for the Phase E run. Removes only what this run created
// (workspaces named in the app's own registry), then verifies nothing is left behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, UD, log } from "./common.mjs";

const PODMAN = process.env.AW_E2E_PODMAN ?? join(HOME, "podman-dist/podman/bin/podman");
const HOMES = join(HOME, ".awd");
const DATA = join(HOME, "aw-workspaces");
const REGISTRY = join(UD, "local-workspaces.json");
const PORTS = [9031, 9032, 9033, 9034];
const run = (cmd, args, env = {}) => { try { return { code: 0, out: execFileSync(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString() }; } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; } };
const registry = () => (existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : { version: 1, workspaces: [] });
const dirs = (root, re) => (existsSync(root) ? readdirSync(root).filter((d) => re.test(d)) : []);
const podmanEnv = (id) => ({ HOME: join(HOMES, id, "home"), TMPDIR: join("/tmp", `aw-${id}`) });
// Query podman as workspace <id>. All of that workspace's podman state lives under its own HOME, so
// once that dir is gone there is nothing to ask: running podman anyway only errors (the error text
// was being read as container/network names) and re-creates /tmp/aw-<id>/storage-run-<uid> as a
// side effect, which then shows up as a leftover caused by the check itself.
const podmanFor = (id, args) => (existsSync(podmanEnv(id).HOME) ? run(PODMAN, args, podmanEnv(id)) : { code: 0, out: "" });

export async function teardown() {
  const ids = new Set([...registry().workspaces.map((w) => w.id), ...dirs(HOMES, /^local/), ...dirs(DATA, /^local/)]);
  for (const id of ids) {
    if (!/^local/.test(id)) continue;
    log("teardown", id);
    run(PODMAN, ["machine", "rm", "--force", `aw-${id}`], podmanEnv(id));
    for (const p of [join(HOMES, id), join(DATA, id), join("/tmp", `aw-${id}`)]) rmSync(p, { recursive: true, force: true });
  }
  // The app has no in-app removal of a local workspace (known gap), so the registry is emptied here.
  writeFileSync(REGISTRY, JSON.stringify({ ...registry(), workspaces: [] }, null, 2));
}

/** Everything one workspace id owns on this Mac (empty/false fields mean it is fully gone). */
export function wsState(id, ports = []) {
  const machines = podmanFor(id, ["machine", "list", "--format", "{{.Name}}"]).out.split("\n").map((l) => l.trim().replace(/\*$/, "")).filter((n) => n === `aw-${id}`);
  const ctrs = podmanFor(id, ["ps", "-a", "--format", "{{.Names}}"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  const nets = podmanFor(id, ["network", "ls", "--format", "{{.Name}}"]).out.split("\n").map((l) => l.trim()).filter((n) => n && n !== "podman");
  const procs = run("pgrep", ["-fl", `aw-${id}`]).out.split("\n").filter((l) => l.includes(`aw-${id}`) && !l.includes("pgrep"));
  const dirsLeft = [join(HOMES, id), join(DATA, id), join("/tmp", `aw-${id}`)].filter((d) => existsSync(d));
  const listening = ports.filter((p) => run("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).out.trim() !== "");
  return { machines, ctrs, nets, procs, dirsLeft, listening, inRegistry: registry().workspaces.some((w) => w.id === id) };
}
export const registryWorkspaces = () => registry().workspaces;

export async function leftovers() {
  const ids = [...new Set([...dirs(HOMES, /^local/), ...registry().workspaces.map((w) => w.id)])];
  const machines = [];
  for (const id of ids) {
    const r = podmanFor(id, ["machine", "list", "--format", "{{.Name}}"]);
    machines.push(...r.out.split("\n").map((l) => l.trim().replace(/\*$/, "")).filter((n) => n.startsWith("aw-local")));
  }
  const ctrs = run("pgrep", ["-fl", "aw-local"]).out.split("\n").filter((l) => l.includes("aw-local") && !l.includes("pgrep"));
  const ports = PORTS.filter((p) => run("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).out.trim() !== "");
  const left = [...dirs(HOMES, /^local/).map((d) => `${HOMES}/${d}`), ...dirs(DATA, /^local/).map((d) => `${DATA}/${d}`), ...dirs("/tmp", /^aw-local/).map((d) => `/tmp/${d}`)];
  const reg = registry().workspaces;
  const res = (ok, detail) => ({ ok, detail: ok ? "none" : detail });
  return {
    "podman machines (aw-local*)": res(machines.length === 0, machines.join(",")),
    "aw-local* containers/processes": res(ctrs.length === 0, ctrs.join(" | ")),
    "ports 9031-9034 free": res(ports.length === 0, ports.join(",")),
    "data/home/tmp dirs gone": res(left.length === 0, left.join(",")),
    "registry empty": res(reg.length === 0, reg.map((w) => w.id).join(",")),
  };
}
