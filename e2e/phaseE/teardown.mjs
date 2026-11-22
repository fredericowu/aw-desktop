// Teardown + leftovers checks for the Phase E run. The run registers every workspace it creates
// with adopt(name) (the id comes from the registry entry for the name the harness itself chose);
// teardown and leftovers touch ONLY those adopted ids. A workspace some other Desktop profile
// creates mid-run is never adopted, so it is never deleted or reported. snapshot() additionally
// records the busy ports before the run so they are excluded from the port check.
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

const listening = (p) => run("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).out.trim() !== "";
let baseline = null;
// Ids of workspaces this run created. Kept for the whole run (never dropped after teardown), so the
// leftovers checks can still look for a workspace whose removal failed.
const adopted = new Set();
let removalFailures = [];
/** Call once before the run creates anything. */
export function snapshot() {
  baseline = { ids: new Set(registry().workspaces.map((w) => w.id)), ports: new Set(PORTS.filter(listening)) };
  log("baseline ports (excluded from the port check):", [...baseline.ports]);
}
/**
 * Wait for the registry entry of the workspace this run just created (by the unique name the harness
 * gave it), remember its id as run-owned and return it ({id, uiPort, ...}). The port to wait on must
 * come from here: a stopped workspace elsewhere can reserve 9031/9032, so the new one may not get them.
 */
export async function adopt(name, timeoutMs = 60000) {
  if (!baseline) throw new Error("teardown.snapshot() must run before the run creates workspaces");
  const end = Date.now() + timeoutMs;
  for (;;) {
    const w = registry().workspaces.find((x) => x.name === name && !baseline.ids.has(x.id));
    if (w) { adopted.add(w.id); return w; }
    if (Date.now() > end) throw new Error(`no new registry entry named ${name} appeared within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const owned = () => {
  if (!baseline) throw new Error("teardown.snapshot() must run before the run creates workspaces; refusing to guess what is safe to delete");
  return [...adopted];
};
// Only a diagnostic that names THIS machine as absent counts as "already gone". A generic "not found"
// (e.g. "vfkit helper not found in PATH") means podman could not even try, so the VM may survive.
const machineGone = (id, out) => new RegExp(`aw-${id}\\b[^\\n]*(does not exist|no such|not found)|no such (vm|machine)[^\\n]*aw-${id}\\b`, "i").test(out);

export async function teardown() {
  removalFailures = [];
  const keep = new Set();
  for (const id of owned()) {
    log("teardown", id);
    // Only delete the dirs (the handle podmanFor needs to find the VM again) once podman confirms the
    // machine is gone; otherwise keep them so leftovers() still reports the surviving machine.
    const r = podmanFor(id, ["machine", "rm", "--force", `aw-${id}`]);
    if (r.code !== 0 && !machineGone(id, r.out)) {
      removalFailures.push(`${id}: podman machine rm exit ${r.code}: ${r.out.trim().slice(0, 200)}`);
      keep.add(id);
      continue;
    }
    for (const p of [join(HOMES, id), join(DATA, id), join("/tmp", `aw-${id}`)]) rmSync(p, { recursive: true, force: true });
  }
  // Drop only registry entries of run-owned ids whose machine is gone; everything else stays.
  const reg = registry();
  const drop = new Set([...adopted].filter((id) => !keep.has(id)));
  writeFileSync(REGISTRY, JSON.stringify({ ...reg, workspaces: reg.workspaces.filter((w) => !drop.has(w.id)) }, null, 2));
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
    "podman machine removal succeeded": res(removalFailures.length === 0, removalFailures.join(" | ")),
    "podman machines (run-created)": res(machines.length === 0, machines.join(",")),
    "run-created containers/processes": res(ctrs.length === 0, ctrs.join(" | ")),
    "ports 9031-9034 free (excluding pre-existing)": res(ports.length === 0, ports.join(",")),
    "data/home/tmp dirs gone": res(left.length === 0, left.join(",")),
    "registry has no run-created entries": res(reg.length === 0, reg.map((w) => w.id).join(",")),
  };
}
