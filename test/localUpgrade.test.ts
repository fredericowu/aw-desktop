import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/aw-test-userdata" } }));

import {
  LEGACY_WORKSPACE_IMAGE,
  LocalRuntime,
  UPGRADE_PRESERVED,
  UpgradeFailedError,
  WORKSPACE_IMAGE,
  containerNames,
  pinnedImage,
  upgradeAvailable,
  workspacePaths,
  type FsOps,
  type RunResult,
  type RuntimeConfig,
} from "../src/main/localRuntime";
import { LocalRegistry, type LocalWorkspace } from "../src/main/localRegistry";
import { toWorkspaceInfo } from "../src/main/localWorkspaces";

const cfg: RuntimeConfig = {
  podmanPath: "/app/podman",
  homesRoot: "/Users/u/.awd",
  dataRoot: "/Users/u/aw-workspaces",
  path: "/app/bin:/usr/bin",
  arch: "arm64",
};
const ID = "localaaa";
const paths = workspacePaths(cfg, ID);
const names = containerNames(ID);
const ws: LocalWorkspace = { id: ID, name: "Mine", sub: "s", uiPort: 9031, apiPort: 9032, createdAt: "t", cloud: "none" }; // no pin = legacy v0.158.0
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 125, stdout: "", stderr });

/** In-memory tree: path -> content (null = directory). rename/rmrf move/delete whole subtrees. */
class MemFs implements FsOps {
  nodes = new Map<string, string | null>();
  private kids(p: string) {
    return [...this.nodes.keys()].filter((k) => k !== p && k.startsWith(p + "/"));
  }
  mkdirp(p: string) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const d = "/" + parts.slice(0, i).join("/");
      if (!this.nodes.has(d)) this.nodes.set(d, null);
    }
  }
  writeFile(p: string, d: string) {
    this.mkdirp(p.slice(0, p.lastIndexOf("/")));
    this.nodes.set(p, d);
  }
  readFile(p: string) {
    return this.nodes.get(p) ?? null;
  }
  isEmptyDir(p: string) {
    return this.listDir(p).length === 0;
  }
  rmrf(p: string) {
    for (const k of [p, ...this.kids(p)]) this.nodes.delete(k);
  }
  rename(from: string, to: string) {
    if (!this.nodes.has(from)) throw new Error(`ENOENT ${from}`);
    this.mkdirp(to.slice(0, to.lastIndexOf("/")));
    for (const k of [from, ...this.kids(from)]) {
      const v = this.nodes.get(k)!;
      this.nodes.delete(k);
      this.nodes.set(to + k.slice(from.length), v);
    }
  }
  listDir(p: string) {
    return [...new Set(this.kids(p).map((k) => k.slice(p.length + 1).split("/")[0]))];
  }
  exists(p: string) {
    return this.nodes.has(p);
  }
}

interface Container { image: string; running: boolean }
interface World {
  rt: LocalRuntime;
  fs: MemFs;
  calls: string[];
  containers: Map<string, Container>;
  db: { value: string; dump: string | null };
  committed: string[];
  /** Per-test fault injection: return a result to override the fake engine for a command. */
  inject: { fn: (j: string) => RunResult | undefined };
  healthy: { fn: (image: string | null) => boolean };
  machineRunning: { value: boolean };
}

function world(): World {
  const fs = new MemFs();
  const w = paths.workspace;
  fs.writeFile(`${w}/src/core.py`, "core v158");
  fs.writeFile(`${w}/.git/HEAD`, "head v158");
  fs.writeFile(`${w}/.aw-workspace/data/app1/state`, "app state");
  fs.writeFile(`${w}/apps/app1/manifest`, "installed app");
  fs.writeFile(`${w}/repos/mine/file`, "user checkout");
  const containers = new Map<string, Container>([
    [names.postgres, { image: "pg", running: true }],
    [names.redis, { image: "redis", running: true }],
    [names.workspace, { image: LEGACY_WORKSPACE_IMAGE, running: true }],
  ]);
  const db = { value: "pre-upgrade rows", dump: null as string | null };
  const calls: string[] = [];
  const inject = { fn: (_j: string): RunResult | undefined => undefined };
  const healthy = { fn: (_img: string | null) => true };
  const machineRunning = { value: true };
  let t = 0;
  const rt = new LocalRuntime(cfg, {
    fs,
    sleep: async () => void (t += 1000),
    now: () => t,
    newSecret: () => "pw",
    httpStatus: async () => {
      const c = containers.get(names.workspace);
      return c?.running && healthy.fn(c.image) ? 200 : 0;
    },
    run: async (_cmd, argv) => {
      const args = argv[0] === "--connection" ? argv.slice(2) : argv;
      const j = args.join(" ");
      calls.push(j);
      const forced = inject.fn(j);
      if (forced) return forced;
      if (j.startsWith("machine list")) return j.includes("{{.Running}}") ? ok(`aw-${ID} ${machineRunning.value}\n`) : ok(`aw-${ID}*\n`);
      if (j.startsWith("machine start")) { machineRunning.value = true; return ok(); }
      if (j.startsWith("machine ssh")) return ok("/run/user/1000/podman/podman.sock");
      if (j.startsWith("image exists") || j.startsWith("network exists")) return ok();
      if (j.startsWith("container exists")) return containers.has(args[2]) ? ok() : { code: 1, stdout: "", stderr: "" };
      if (j.includes("{{.State.Running}}")) return ok(String(containers.get(args[1])?.running));
      if (j.includes("PortBindings")) return ok(`{"9030/tcp":[{"HostPort":"9032"}]}`);
      if (args[0] === "create") { containers.set(args[args.indexOf("--name") + 1], { image: args.at(-1)!, running: false }); return ok(); }
      if (args[0] === "cp") {
        const dest = args[2];
        fs.writeFile(`${dest}/src/core.py`, "core v165");
        fs.writeFile(`${dest}/.git/HEAD`, "head v165");
        fs.writeFile(`${dest}/native-skills/x`, "new in v165");
        fs.writeFile(`${dest}/.aw-workspace/venv/image-copy`, "must never land");
        fs.writeFile(`${dest}/apps/README.md`, "must never land");
        return ok();
      }
      if (args[0] === "rm") { containers.delete(args.at(-1)!); return ok(); }
      if (args[0] === "stop") { containers.get(args[1])!.running = false; return ok(); }
      if (args[0] === "start") { containers.get(args[1])!.running = true; return ok(); }
      if (args[0] === "rename") { const c = containers.get(args[1])!; containers.delete(args[1]); containers.set(args[2], c); return ok(); }
      if (args[0] === "run") {
        const name = args[args.indexOf("--name") + 1];
        const image = args.at(-1)!;
        if (name === names.workspace) {
          if (containers.has(name)) return fail("name in use");
          containers.set(name, { image, running: true });
          if (image !== LEGACY_WORKSPACE_IMAGE) db.value = "migrated forward"; // a new core migrates the DB at boot
        }
        return ok();
      }
      if (j.includes("pg_dump")) { db.dump = db.value; return ok(); }
      if (j.includes("DROP DATABASE")) { db.value = "empty"; return ok(); }
      if (j.includes("pg_restore")) { db.value = db.dump!; return ok(); }
      return ok();
    },
  });
  const committed: string[] = [];
  return { rt, fs, calls, containers, db, committed, inject, healthy, machineRunning };
}

const upgrade = (w: World, extra: Partial<Parameters<LocalRuntime["upgrade"]>[1]> = {}) =>
  w.rt.upgrade(ws, { onCommit: (i) => void w.committed.push(i), healthTimeoutMs: 5000, ...extra });
const idx = (calls: string[], needle: string) => calls.findIndex((c) => c.includes(needle));

describe("pin helpers", () => {
  it("an unpinned workspace is legacy and upgradable; a workspace on the bundled image is not", () => {
    expect(pinnedImage({})).toBe(LEGACY_WORKSPACE_IMAGE);
    expect(upgradeAvailable({})).toBe(true);
    expect(upgradeAvailable({ image: LEGACY_WORKSPACE_IMAGE })).toBe(true);
    expect(upgradeAvailable({ image: WORKSPACE_IMAGE })).toBe(false);
  });
  it("installed apps, secrets and user checkouts are never overwritten", () => {
    for (const n of [".aw-workspace", "apps", "repos", ".claude", ".codex"]) expect(UPGRADE_PRESERVED.has(n)).toBe(true);
  });
  it("the picker row flags upgrade_available only for local rows on an older core", () => {
    expect(toWorkspaceInfo(ws, true).upgrade_available).toBe(true);
    expect(toWorkspaceInfo({ ...ws, image: WORKSPACE_IMAGE }, true).upgrade_available).toBeUndefined();
  });
  it("the registry persists a new pin and only for that workspace", () => {
    let raw: string | null = JSON.stringify({ version: 1, workspaces: [ws, { ...ws, id: "localbbb", uiPort: 9033, apiPort: 9034 }] });
    const reg = new LocalRegistry({ store: { read: () => raw, write: (d) => void (raw = d) } });
    reg.setImage(ID, WORKSPACE_IMAGE);
    expect(reg.get(ID)?.image).toBe(WORKSPACE_IMAGE);
    expect(reg.get("localbbb")?.image).toBeUndefined();
    expect(() => reg.setImage("nope", WORKSPACE_IMAGE)).toThrow();
  });
});

describe("LocalRuntime.upgrade: success", () => {
  it("swaps the image-owned tree, keeps data/apps/checkouts, recreates only the core, commits after health", async () => {
    const w = world();
    const r = await upgrade(w);
    expect(r.upgraded).toBe(true);
    const ws0 = paths.workspace;
    // image-owned entries came from the new image
    expect(w.fs.readFile(`${ws0}/src/core.py`)).toBe("core v165");
    expect(w.fs.readFile(`${ws0}/.git/HEAD`)).toBe("head v165");
    expect(w.fs.readFile(`${ws0}/native-skills/x`)).toBe("new in v165");
    // preserved entries are byte-for-byte what they were; nothing from the image's copies landed
    expect(w.fs.readFile(`${ws0}/.aw-workspace/data/app1/state`)).toBe("app state");
    expect(w.fs.readFile(`${ws0}/apps/app1/manifest`)).toBe("installed app");
    expect(w.fs.readFile(`${ws0}/repos/mine/file`)).toBe("user checkout");
    expect(w.fs.exists(`${ws0}/.aw-workspace/venv/image-copy`)).toBe(false);
    expect(w.fs.exists(`${ws0}/apps/README.md`)).toBe(false);
    // the core now runs the bundled image; the old container, scratch dir and journal are gone
    expect(w.containers.get(names.workspace)).toEqual({ image: WORKSPACE_IMAGE, running: true });
    expect(w.containers.has(`${names.workspace}-prev`)).toBe(false);
    expect(w.fs.listDir(paths.data).filter((n) => n.startsWith("upgrade"))).toEqual([]);
    expect(w.committed).toEqual([WORKSPACE_IMAGE]);
    // database untouched by the upgrade itself (the new core migrates it, not us)
    expect(w.db.value).toBe("migrated forward");
  });

  it("orders it safely: pull, stage, stop, dump, rename old, run new, THEN commit; old container is kept until commit", async () => {
    const w = world();
    let commitAt = -1;
    await upgrade(w, { onCommit: () => void (commitAt = w.calls.length) });
    const c = w.calls;
    const order = [idx(c, `pull ${WORKSPACE_IMAGE}`) === -1 ? idx(c, "create --pull=never --name aw-localaaa-upgrade-seed") : idx(c, "pull"), idx(c, "cp aw-localaaa-upgrade-seed"), idx(c, `stop ${names.workspace}`), idx(c, "pg_dump"), idx(c, `rename ${names.workspace} ${names.workspace}-prev`), idx(c, `run -d --pull=never --name ${names.workspace} `)];
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
    // the old container is only removed after the commit callback ran
    expect(commitAt).toBeGreaterThan(order[5]);
    // no removal of the old container between recreating the core and the commit; it goes only afterwards
    expect(c.slice(order[5], commitAt).some((x) => x === `rm -f ${names.workspace}-prev`)).toBe(false);
    expect(c.slice(commitAt).some((x) => x === `rm -f ${names.workspace}-prev`)).toBe(true);
  });

  it("never touches the VM, postgres or redis, and never uses force-bootstrap or unlink", async () => {
    const w = world();
    await upgrade(w);
    const all = w.calls.join("\n");
    expect(all).not.toMatch(/machine (rm|stop|init)/);
    expect(all).not.toContain("network rm");
    expect(all).not.toMatch(new RegExp(`(rm|stop|rename) .*(${names.postgres}|${names.redis})`));
    expect(all).not.toMatch(/--force|unlink|bootstrap/);
  });

  it("does nothing when the workspace already runs the target image", async () => {
    const w = world();
    const r = await w.rt.upgrade({ ...ws, image: WORKSPACE_IMAGE }, { onCommit: (i) => void w.committed.push(i) });
    expect(r.upgraded).toBe(false);
    expect(w.calls.some((c) => c.startsWith("stop") || c.includes("pg_dump") || c.startsWith("cp"))).toBe(false);
    expect(w.committed).toEqual([]);
    expect(w.containers.get(names.workspace)?.running).toBe(true);
  });

  it("starts a stopped machine first", async () => {
    const w = world();
    w.machineRunning.value = false;
    await upgrade(w);
    expect(idx(w.calls, "machine start")).toBeGreaterThanOrEqual(0);
    expect(idx(w.calls, "machine start")).toBeLessThan(idx(w.calls, "pg_dump"));
  });
});

describe("LocalRuntime.upgrade: failure leaves the old workspace working", () => {
  it("a failed image pull changes nothing: old core never stopped, tree and pin untouched", async () => {
    const w = world();
    w.inject.fn = (j) => (j.startsWith("image exists") && j.includes(WORKSPACE_IMAGE) ? { code: 1, stdout: "", stderr: "" } : j.startsWith(`pull ${WORKSPACE_IMAGE}`) ? fail("network down") : undefined);
    const err = await upgrade(w).catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeFailedError);
    expect(err.rolledBack).toBe(true);
    expect(w.calls.some((c) => c.startsWith("stop") || c.includes("pg_dump"))).toBe(false);
    expect(w.containers.get(names.workspace)).toEqual({ image: LEGACY_WORKSPACE_IMAGE, running: true });
    expect(w.fs.readFile(`${paths.workspace}/src/core.py`)).toBe("core v158");
    expect(w.committed).toEqual([]);
  });

  it("a staging failure mid-copy drops the scratch dir and leaves the running core alone", async () => {
    const w = world();
    w.inject.fn = (j) => (j.startsWith("cp ") ? fail("no space left") : undefined);
    const err = await upgrade(w).catch((e) => e);
    expect(err.rolledBack).toBe(true);
    expect(w.fs.listDir(paths.data).filter((n) => n.startsWith("upgrade"))).toEqual([]);
    expect(w.containers.get(names.workspace)).toEqual({ image: LEGACY_WORKSPACE_IMAGE, running: true });
    expect(w.fs.readFile(`${paths.workspace}/src/core.py`)).toBe("core v158");
  });

  it("a new core that never gets healthy is rolled back: tree, DB, container and pin all as before", async () => {
    const w = world();
    w.healthy.fn = (img) => img === LEGACY_WORKSPACE_IMAGE; // the new core never answers
    const err = await upgrade(w).catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeFailedError);
    expect(err.rolledBack).toBe(true);
    expect(w.committed).toEqual([]); // the pin was never persisted
    expect(w.db.value).toBe("pre-upgrade rows"); // the dump was restored over the migrated DB
    const ws0 = paths.workspace;
    expect(w.fs.readFile(`${ws0}/src/core.py`)).toBe("core v158");
    expect(w.fs.readFile(`${ws0}/.git/HEAD`)).toBe("head v158");
    expect(w.fs.exists(`${ws0}/native-skills`)).toBe(false); // an entry that did not exist before is removed again
    expect(w.fs.readFile(`${ws0}/.aw-workspace/data/app1/state`)).toBe("app state");
    expect(w.fs.readFile(`${ws0}/apps/app1/manifest`)).toBe("installed app");
    expect(w.containers.get(names.workspace)).toEqual({ image: LEGACY_WORKSPACE_IMAGE, running: true });
    expect(w.containers.has(`${names.workspace}-prev`)).toBe(false);
    expect(w.fs.exists(`${paths.data}/upgrade.json`)).toBe(false);
    expect(w.fs.listDir(paths.data).filter((n) => n.startsWith("upgrade"))).toEqual([]);
  });

  it("a failing commit callback (pin not persisted) rolls back too", async () => {
    const w = world();
    const err = await upgrade(w, { onCommit: () => { throw new Error("disk full"); } }).catch((e) => e);
    expect(err.rolledBack).toBe(true);
    expect(w.containers.get(names.workspace)?.image).toBe(LEGACY_WORKSPACE_IMAGE);
    expect(w.fs.readFile(`${paths.workspace}/src/core.py`)).toBe("core v158");
  });

  it("when the rollback itself fails the journal stays and the next start() finishes the rollback", async () => {
    const w = world();
    w.healthy.fn = (img) => img === LEGACY_WORKSPACE_IMAGE;
    let restoreFails = true;
    w.inject.fn = (j) => (restoreFails && j.includes("pg_restore") ? fail("restore interrupted") : undefined);
    const err = await upgrade(w).catch((e) => e);
    expect(err).toBeInstanceOf(UpgradeFailedError);
    expect(err.rolledBack).toBe(false);
    expect(w.fs.exists(`${paths.data}/upgrade.json`)).toBe(true);
    // Later (app relaunch): a normal start resumes the rollback before touching anything else.
    restoreFails = false;
    await w.rt.start(ws, { healthTimeoutMs: 5000 });
    expect(w.db.value).toBe("pre-upgrade rows");
    expect(w.fs.readFile(`${paths.workspace}/src/core.py`)).toBe("core v158");
    expect(w.containers.get(names.workspace)).toEqual({ image: LEGACY_WORKSPACE_IMAGE, running: true });
    expect(w.fs.exists(`${paths.data}/upgrade.json`)).toBe(false);
    expect(w.committed).toEqual([]);
  });

  it("a journal left at 'committed' (crash after the pin was saved) only gets its leftovers cleaned: no rollback", async () => {
    const w = world();
    const root = `${paths.data}/upgrade-0`;
    w.fs.writeFile(`${root}/backup/src/core.py`, "old");
    w.fs.writeFile(`${paths.data}/upgrade.json`, JSON.stringify({ v: 1, from: LEGACY_WORKSPACE_IMAGE, to: WORKSPACE_IMAGE, phase: "committed", root, dump: "aw-upgrade-0.dump", replace: ["src"], add: [] }));
    w.containers.set(`${names.workspace}-prev`, { image: LEGACY_WORKSPACE_IMAGE, running: false });
    w.containers.get(names.workspace)!.image = WORKSPACE_IMAGE;
    await w.rt.start({ ...ws, image: WORKSPACE_IMAGE }, { healthTimeoutMs: 5000 });
    expect(w.fs.exists(root)).toBe(false);
    expect(w.fs.exists(`${paths.data}/upgrade.json`)).toBe(false);
    expect(w.containers.has(`${names.workspace}-prev`)).toBe(false);
    expect(w.containers.get(names.workspace)?.image).toBe(WORKSPACE_IMAGE);
    expect(w.calls.some((c) => c.includes("pg_restore"))).toBe(false);
    expect(w.fs.readFile(`${paths.workspace}/src/core.py`)).toBe("core v158"); // untouched: this fake never swapped it
  });
});
