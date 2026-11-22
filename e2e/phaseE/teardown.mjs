// Teardown + leftovers checks for the Phase E run. snapshot() records every workspace id and busy
// port that exists BEFORE the run; teardown and leftovers only ever touch ids that appeared after
// it, so a pre-existing workspace on the same Mac is never deleted or reported.
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

const allIds = () => new Set([...registry().workspaces.map((w) => w.id), ...dirs(HOMES, /^local/), ...dirs(DATA, /^local/), ...dirs("/tmp", /^aw-local/).map((d) => d.slice(3))].filter((id) => /^local/.test(id)));
const listening = (p) => run("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).out.trim() !== "";
let baseline = null;
/** Call once before the run creates anything. */
export function snapshot() {
  baseline = { ids: allIds(), ports: new Set(PORTS.filter(listening)) };
  log("baseline (left untouched):", [...baseline.ids], "busy ports:", [...baseline.ports]);
}
const owned = () => {
  if (!baseline) throw new Error("teardown.snapshot() must run before the run creates workspaces; refusing to guess what is safe to delete");
  return [...allIds()].filter((id) => !baseline.ids.has(id));
};

export async function teardown() {
  for (const id of owned()) {
    log("teardown", id);
    run(PODMAN, ["machine", "rm", "--force", `aw-${id}`], podmanEnv(id));
    for (const p of [join(HOMES, id), join(DATA, id), join("/tmp", `aw-${id}`)]) rmSync(p, { recursive: true, force: true });
  }
  // Drop only registry entries this run created; pre-existing ones stay.
  const reg = registry();
  writeFileSync(REGISTRY, JSON.stringify({ ...reg, workspaces: reg.workspaces.filter((w) => baseline.ids.has(w.id)) }, null, 2));
}

/** Everything one workspace id owns on this Mac (empty/false fields mean it is fully gone). */
export function wsState(id, ports = []) {
  const machines = podmanFor(id, ["machine", "list", "--format", "{{.Name}}"]).out.split("\n").map((l) => l.trim().replace(/\*$/, "")).filter((n) => n === `aw-${id}`);
  const ctrs = podmanFor(id, ["ps", "-a", "--format", "{{.Names}}"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  const nets = podmanFor(id, ["network", "ls", "--format", "{{.Name}}"]).out.split("\n").map((l) => l.trim()).filter((n) => n && n !== "podman");
  const procs = run("pgrep", ["-fl", `aw-${id}`]).out.split("\n").filter((l) => l.includes(`aw-${id}`) && !l.includes("pgrep"));
  const dirsLeft = [join(HOMES, id), join(DATA, id), join("/tmp", `aw-${id}`)].filter((d) => existsSync(d));
  const busy = ports.filter(listening);
  return { machines, ctrs, nets, procs, dirsLeft, listening: busy, inRegistry: registry().workspaces.some((w) => w.id === id) };
}
export const registryWorkspaces = () => registry().workspaces;

export async function leftovers() {
  const ids = owned();
  const machines = [];
  for (const id of ids) {
    const r = podmanFor(id, ["machine", "list", "--format", "{{.Name}}"]);
    machines.push(...r.out.split("\n").map((l) => l.trim().replace(/\*$/, "")).filter((n) => n === `aw-${id}`));
  }
  const ctrs = ids.flatMap((id) => run("pgrep", ["-fl", `aw-${id}`]).out.split("\n").filter((l) => l.includes(`aw-${id}`) && !l.includes("pgrep")));
  const ports = PORTS.filter((p) => !baseline.ports.has(p) && listening(p));
  const left = ids.flatMap((id) => [join(HOMES, id), join(DATA, id), join("/tmp", `aw-${id}`)].filter((d) => existsSync(d)));
  const reg = registry().workspaces.filter((w) => ids.includes(w.id));
  const res = (ok, detail) => ({ ok, detail: ok ? "none" : detail });
  return {
    "podman machines (run-created)": res(machines.length === 0, machines.join(",")),
    "run-created containers/processes": res(ctrs.length === 0, ctrs.join(" | ")),
    "ports 9031-9034 free (excluding pre-existing)": res(ports.length === 0, ports.join(",")),
    "data/home/tmp dirs gone": res(left.length === 0, left.join(",")),
    "registry has no run-created entries": res(reg.length === 0, reg.map((w) => w.id).join(",")),
  };
}
