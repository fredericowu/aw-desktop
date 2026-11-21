// Persisted per-user registry of standalone local workspaces (card 41f5bf3b,
// design v2 + spike). Pure logic: no electron imports. Storage, port probing
// and the limit fetch are injected so everything is unit-testable.
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FIRST_LOCAL_PORT = 9031;
/** Port of the live/hosted workspace core on a machine; never ours. */
export const RESERVED_PORT = 9030;
export const DEFAULT_MAX_LOCAL = 2;

export interface LocalWorkspace {
  id: string;
  name: string;
  /** Identity `sub` of the account that created it; the cap counts per sub. */
  sub: string;
  uiPort: number;
  apiPort: number;
  createdAt: string;
  /** "none" = standalone. A later tunnel/connect phase just points at apiPort. */
  cloud: "none";
}

export interface RegistryFile {
  version: 1;
  workspaces: LocalWorkspace[];
  /** Last limits.max_local_workspaces seen per account `sub`, so the cap works offline. */
  cachedMaxLocalBySub?: Record<string, number>;
}

export class LocalLimitReachedError extends Error {
  readonly code = "local_limit_reached";
  constructor(
    public readonly limit: number,
    public readonly count: number,
  ) {
    super(`Local workspace limit reached (${count}/${limit})`);
    this.name = "LocalLimitReachedError";
  }
}

export class NoFreePortError extends Error {
  constructor() {
    super("No free loopback port available");
    this.name = "NoFreePortError";
  }
}

export type PortProbe = (port: number) => Promise<boolean>;

/** True when 127.0.0.1:<port> can be bound right now. */
export const probeLoopbackPort: PortProbe = (port) =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

/** Next free port >= from, skipping 9030, `taken`, and anything the probe says is busy. */
export async function findFreePort(
  isFree: PortProbe,
  taken: ReadonlySet<number>,
  from = FIRST_LOCAL_PORT,
  maxPort = 65535,
): Promise<number> {
  for (let p = Math.max(from, FIRST_LOCAL_PORT); p <= maxPort; p++) {
    if (p === RESERVED_PORT || taken.has(p)) continue;
    if (await isFree(p)) return p;
  }
  throw new NoFreePortError();
}

/** Two distinct ports (UI, API). `taken` = ports already persisted for other workspaces. */
export async function allocatePorts(
  isFree: PortProbe,
  taken: ReadonlySet<number>,
  from = FIRST_LOCAL_PORT,
): Promise<{ uiPort: number; apiPort: number }> {
  const uiPort = await findFreePort(isFree, taken, from);
  const apiPort = await findFreePort(isFree, new Set([...taken, uiPort]), uiPort + 1);
  return { uiPort, apiPort };
}

export interface RegistryStore {
  read(): string | null;
  write(data: string): void;
}

export function fileStore(path: string): RegistryStore {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (data) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export function registryPath(userDataDir: string): string {
  return join(userDataDir, "local-workspaces.json");
}

export interface LocalRegistryDeps {
  store: RegistryStore;
  isPortFree?: PortProbe;
  now?: () => Date;
  newId?: () => string;
  /** Returns limits.max_local_workspaces from GET /api/accounts/me (undefined if the backend omits it). */
  fetchMaxLocal?: (sub: string) => Promise<number | undefined>;
}

export function newLocalId(): string {
  // Lowercase alphanumeric, no hyphens: it becomes AW_WORKSPACE / the schema name.
  return `local${randomBytes(3).toString("hex")}`;
}

function parse(raw: string | null): RegistryFile {
  if (!raw) return { version: 1, workspaces: [] };
  try {
    const j = JSON.parse(raw) as Partial<RegistryFile>;
    const workspaces = Array.isArray(j.workspaces) ? j.workspaces.filter(isRecord) : [];
    const cached: Record<string, number> = {};
    const bySub = j.cachedMaxLocalBySub;
    if (bySub && typeof bySub === "object") {
      for (const [k, v] of Object.entries(bySub)) if (typeof v === "number") cached[k] = v;
    }
    return { version: 1, workspaces, cachedMaxLocalBySub: cached };
  } catch {
    return { version: 1, workspaces: [] };
  }
}

function isRecord(w: unknown): w is LocalWorkspace {
  if (!w || typeof w !== "object") return false;
  const r = w as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.sub === "string" &&
    r.sub !== "" &&
    typeof r.uiPort === "number" &&
    typeof r.apiPort === "number" &&
    typeof r.createdAt === "string"
  );
}

export class LocalRegistry {
  private readonly isPortFree: PortProbe;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: LocalRegistryDeps) {
    this.isPortFree = deps.isPortFree ?? probeLoopbackPort;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? newLocalId;
  }

  private load(): RegistryFile {
    return parse(this.deps.store.read());
  }
  private save(f: RegistryFile): void {
    this.deps.store.write(JSON.stringify(f, null, 2));
  }

  /** Every record in the store (all accounts); used for port allocation. */
  list(): LocalWorkspace[] {
    return this.load().workspaces;
  }

  /** Records owned by `sub`. */
  listFor(sub: string): LocalWorkspace[] {
    return this.list().filter((w) => w.sub === sub);
  }

  get(id: string): LocalWorkspace | undefined {
    return this.list().find((w) => w.id === id);
  }

  /** Fresh limit from the backend when reachable (and cache it); else the cached
   * last-known value; else DEFAULT_MAX_LOCAL. Never throws on a network failure. */
  async resolveLimit(sub: string): Promise<number> {
    if (this.deps.fetchMaxLocal) {
      try {
        const v = await this.deps.fetchMaxLocal(sub);
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
          // Re-read after the await: a pre-await snapshot would clobber concurrent
          // refreshes (other subs) and intervening workspace edits.
          const cur = this.load();
          this.save({ ...cur, cachedMaxLocalBySub: { ...cur.cachedMaxLocalBySub, [sub]: v } });
          return v;
        }
      } catch {
        /* offline / backend down: fall through to the cache */
      }
    }
    return this.load().cachedMaxLocalBySub?.[sub] ?? DEFAULT_MAX_LOCAL;
  }

  /** Throws LocalLimitReachedError when `sub` already owns `limit` workspaces. */
  async assertCanCreate(sub: string): Promise<void> {
    const limit = await this.resolveLimit(sub);
    const count = this.listFor(sub).length;
    if (count >= limit) throw new LocalLimitReachedError(limit, count);
  }

  /** Cap check, then ports + id, persisted. Client-side cap (bypassable, accepted by the owner). */
  async create(sub: string, name: string): Promise<LocalWorkspace> {
    if (!sub) throw new Error("sub is required to create a local workspace");
    await this.assertCanCreate(sub);
    const f = this.load();
    const taken = new Set<number>();
    for (const w of f.workspaces) {
      taken.add(w.uiPort);
      taken.add(w.apiPort);
    }
    const { uiPort, apiPort } = await allocatePorts(this.isPortFree, taken);
    const ids = new Set(f.workspaces.map((w) => w.id));
    let id = this.newId();
    while (ids.has(id)) id = this.newId();
    const ws: LocalWorkspace = {
      id,
      name: name.trim() || id,
      sub,
      uiPort,
      apiPort,
      createdAt: this.now().toISOString(),
      cloud: "none",
    };
    this.save({ ...f, workspaces: [...f.workspaces, ws] });
    return ws;
  }

  remove(id: string): boolean {
    const f = this.load();
    const next = f.workspaces.filter((w) => w.id !== id);
    if (next.length === f.workspaces.length) return false;
    this.save({ ...f, workspaces: next });
    return true;
  }

  /** At start: a persisted port that is busy (and not ours-in-use) is bumped and re-persisted.
   * `heldByUs(port)` lets the caller say "this port is busy because our own container holds it". */
  async reconcilePorts(
    id: string,
    heldByUs: (port: number) => boolean = () => false,
  ): Promise<{ workspace: LocalWorkspace; uiChanged: boolean; apiChanged: boolean }> {
    const f = this.load();
    const cur = f.workspaces.find((w) => w.id === id);
    if (!cur) throw new Error(`unknown local workspace ${id}`);
    const others = new Set<number>();
    for (const w of f.workspaces) if (w.id !== id) (others.add(w.uiPort), others.add(w.apiPort));
    const ok = async (p: number, extra: number[]) =>
      p !== RESERVED_PORT && !others.has(p) && !extra.includes(p) && (heldByUs(p) || (await this.isPortFree(p)));
    let { uiPort, apiPort } = cur;
    if (!(await ok(uiPort, []))) uiPort = await findFreePort(this.isPortFree, new Set([...others, apiPort]));
    if (!(await ok(apiPort, [uiPort]))) apiPort = await findFreePort(this.isPortFree, new Set([...others, uiPort]), uiPort + 1);
    const workspace = { ...cur, uiPort, apiPort };
    if (uiPort !== cur.uiPort || apiPort !== cur.apiPort) {
      this.save({ ...f, workspaces: f.workspaces.map((w) => (w.id === id ? workspace : w)) });
    }
    return { workspace, uiChanged: uiPort !== cur.uiPort, apiChanged: apiPort !== cur.apiPort };
  }
}
