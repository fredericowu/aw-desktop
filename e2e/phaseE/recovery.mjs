// Phase E recovery drivers: force quit, hung core, killed VM -> "Needs attention" + Retry, start failure.
// Drives the REAL installed AW Desktop.app (Playwright _electron, no Accessibility permission) with a
// failure-injecting podman shim (shim.mjs) in a COPY of the bundled engine. Needs a logged-in GUI session.
// Usage: AW_E2E_JWT_FILE=<f> AW_E2E_USER_DATA=<throwaway dir> node e2e/phaseE/recovery.mjs
//          [--dry-run] [--teardown] [--reuse] [scenario ...]        (see README.md)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launch as launchApp, pickerWindow, shellWindow, jwt, log, rec, summary, sleep, switchWorkspace, UD, APP, HOME, SHOTS } from "./common.mjs";
import { snapshot, adopt, adoptExisting, teardown, leftovers, hostState } from "./teardown.mjs";
import { hostIntegrityError, workspacePodmanEnv, toolEnv } from "./guard.mjs";
import { prepareEngine, SECRET } from "./shim.mjs";

const ARGV = process.argv.slice(2);
const FLAGS = new Set(ARGV.filter((a) => a.startsWith("--")));
const ALL = ["setup", "kill", "hung", "attention", "forcequit"];
const picked = ARGV.filter((a) => !a.startsWith("--"));
const PLAN = picked.length ? picked : ALL;
const WORK = process.env.AW_E2E_WORK ?? join(process.cwd(), ".tmp/phaseE-recovery");
const ENG_SRC = process.env.AW_E2E_ENGINE_SRC ?? join(APP, "Contents/Resources/engine");
const ENG = join(WORK, "engine");
const MODE_FILE = join(WORK, "mode");
const CALLS = join(WORK, "calls.log");
const HOMES = join(HOME, ".awd");
const NAME = process.env.AW_E2E_WS_NAME ?? "e2e-recovery";

// ---- fail fast on missing configuration, before anything is launched or written ----
const problems = [];
if (!process.env.AW_E2E_JWT_FILE) problems.push("AW_E2E_JWT_FILE is required (file holding the test-account JWT)");
else if (!existsSync(process.env.AW_E2E_JWT_FILE)) problems.push(`AW_E2E_JWT_FILE does not exist: ${process.env.AW_E2E_JWT_FILE}`);
if (!process.env.AW_E2E_USER_DATA) problems.push("AW_E2E_USER_DATA is required: point it at a THROWAWAY dir. These drivers kill VMs and force-quit the app, so they never run against the installed app's real profile");
for (const s of PLAN) if (!ALL.includes(s)) problems.push(`unknown scenario "${s}" (known: ${ALL.join(" ")})`);
if (!FLAGS.has("--reuse") && PLAN.length && PLAN[0] !== "setup") problems.push(`first scenario must be "setup" (it creates the workspace) unless --reuse names an existing "${NAME}" in the registry`);
if (problems.length) { console.error("recovery.mjs: cannot start:\n - " + problems.join("\n - ")); process.exit(2); }

if (FLAGS.has("--dry-run")) {
  console.log("DRY RUN: nothing is launched, copied or written.");
  console.log(JSON.stringify({ app: APP, userData: UD, work: WORK, engineSrc: ENG_SRC, workspaceName: NAME, shots: SHOTS, scenarios: PLAN, teardown: FLAGS.has("--teardown"), reuse: FLAGS.has("--reuse") }, null, 2));
  console.log("app bundle present:", existsSync(APP), "| engine present:", existsSync(join(ENG_SRC, "bin/podman")));
  process.exit(0);
}

mkdirSync(UD, { recursive: true });
const { real: PODMAN_REAL } = prepareEngine(ENG_SRC, ENG, WORK);
writeFileSync(CALLS, "");
const live = new Set();
const launch = async (extra = {}) => { const a = await launchApp({ AW_DESKTOP_ENGINE_DIR: ENG, ...extra }); live.add(a); a.on("close", () => live.delete(a)); return a; };

// ---- helpers (every process lookup is scoped to a workspace id this run owns) ----
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
const setMode = (m) => { writeFileSync(MODE_FILE, m); log("shim mode =", m); };
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8") : "");
const callCount = () => calls().split("\n").length;
const callsSince = (n) => calls().split("\n").slice(n).join("\n");
const diag = () => (existsSync(join(UD, "diagnostics.log")) ? readFileSync(join(UD, "diagnostics.log"), "utf8") : "");
const registry = () => { try { return JSON.parse(readFileSync(join(UD, "local-workspaces.json"), "utf8")).workspaces; } catch { return []; } };
const wsOf = (name) => registry().find((w) => w.name === name);
const out = (cmd, args, env = toolEnv()) => { try { return execFileSync(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).toString().trim(); } catch (e) { return String(e.stdout ?? "").trim(); } };
const vmPids = (id) => out("pgrep", ["-f", `krunkit.*aw-${id}`]).split("\n").filter(Boolean);
const diskFile = (id) => join(HOMES, id, `home/.local/share/containers/podman/machine/libkrun/aw-${id}-arm64.raw`);
const diskInode = (id) => out("stat", ["-f", "%i %z", diskFile(id)]);
const podmanEnv = (id) => workspacePodmanEnv(PODMAN_REAL, HOMES, id);
const machineList = (id) => out(PODMAN_REAL, ["machine", "list", "--format", "{{.Name}} running={{.Running}}"], podmanEnv(id));
const pm = (id, args) => out(PODMAN_REAL, ["--connection", `aw-${id}`, ...args], podmanEnv(id));
const health = (port) => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => String(r.status), () => "down");
const waitFor = async (fn, ms, step = 500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(step); } return null; };
const shell = (app) => shellWindow(app);
const text = (p) => p.evaluate(() => document.body.innerText + "\n[modals] " + [...document.querySelectorAll(".modal, [role=dialog]")].map((e) => e.innerText).join(" || ")).catch(() => "");
async function snap(app, p, name) {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().startsWith("http://127.0.0.1")) { w.show(); w.focus(); } }).catch(() => {});
  await sleep(500);
  await p.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 15000 }).catch((e) => log("screenshot failed", name, String(e).slice(0, 80)));
  const t = await text(p);
  writeFileSync(join(SHOTS, `${name}.txt`), redact(t));
  log("SHOT", name, JSON.stringify(redact(t).replace(/\s+/g, " ").slice(0, 200)));
  return t;
}
// Token-shaped strings never reach the saved text dumps or the log (the JWT, the injected fake secret).
const redact = (s) => String(s).replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[jwt]").replace(/sk-live-[\w]+/g, "[redacted]");
const rowState = (p, id) => p.evaluate((i) => { for (const k of ["here", "starting", "attention", "pending"]) { const e = document.querySelector(`[data-testid="${k}-${i}"]`); if (e) return { k, t: e.innerText.replace(/\s+/g, " ") }; } return null; }, id).catch(() => null);
async function watchRows(p, id, ms, until) {
  const tl = []; const end = Date.now() + ms; let last = "";
  while (Date.now() < end) { const r = await rowState(p, id); const s = r ? `${r.k}: ${r.t}` : "none"; if (s !== last) { tl.push(`${T()} ${s}`); last = s; log("row", s); } if (until && r && until(r, tl)) break; await sleep(500); }
  return tl;
}
const loginPicker = async (app) => { const p = await pickerWindow(app); await p.waitForSelector('[data-testid="local-block"]', { timeout: 40000 }); return p; };
const startWs = async (app, p, id, ms = 240000) => { await p.evaluate((i) => window.aw.pickWorkspace(i), id); return waitFor(async () => shell(app), ms, 2000); };
const killVm = (id) => { const pids = vmPids(id); if (!pids.length) throw new Error(`no VM process for ${id} to kill`); for (const pid of pids) process.kill(Number(pid), "SIGKILL"); log("killed VM pids", pids.join(",")); };
const noDestructive = (txt) => !/machine (rm|init)|\bvolume rm\b| rm -f aw-local\w+-postgres/.test(txt);
async function bringUp(withPicker = false) {
  setMode("pass");
  const app = await launch(); const p = await loginPicker(app);
  const ws = wsOf(NAME);
  if (!(await startWs(app, p, ws.id))) throw new Error("workspace did not come up");
  await waitFor(async () => (await health(ws.apiPort)) === "200", 120000);
  if (withPicker) { await switchWorkspace(app); await sleep(2500); await p.bringToFront().catch(() => {}); }
  return { app, p, ws };
}
const retryBtn = (p, id) => p.locator(`[data-testid="attention-${id}"] button:has-text("Retry")`);

// ---- scenarios ----
const S = {};

// Session seed (same encrypt-and-write as run.mjs step 5) + create the fixture workspace through the wizard.
S.setup = async () => {
  setMode("pass");
  if (!existsSync(join(UD, "session.bin"))) {
    const app = await launch(); const p = await pickerWindow(app);
    await p.waitForSelector('input[type="email"], input[type="password"]', { timeout: 20000 });
    const enc = await app.evaluate(({ safeStorage }, j) => safeStorage.encryptString(j).toString("base64"), jwt());
    writeFileSync(join(UD, "session.bin"), Buffer.from(enc, "base64"));
    await app.close();
  }
  const app = await launch(); const p = await loginPicker(app);
  rec("setup: session loads, picker reached", true, "version " + (await app.evaluate(({ app: a }) => a.getVersion())));
  if (FLAGS.has("--reuse")) { const w = adoptExisting(NAME); rec("setup: reusing existing workspace", true, w.id); await app.close(); return; }
  await p.getByRole("button", { name: /Create new (workspace|sandbox)/ }).first().click();
  await p.locator("#sandbox-name").waitFor();
  await p.fill("#sandbox-name", NAME);
  await p.locator(".modal button.primary").click();
  const w = await adopt(NAME);
  const up = await waitFor(async () => shellWindow(app, w.uiPort), 600000, 1500);
  rec("setup: fixture workspace created and healthy", !!up && (await health(w.apiPort)) === "200", `id ${w.id}`);
  await app.close();
  await waitFor(async () => vmPids(w.id).length === 0, 120000);
};

// Kill the VM with the workspace window open: supervisor restarts the SAME VM (no init/rm), disk preserved.
S.kill = async () => {
  const { app, p, ws } = await bringUp();
  const disk0 = diskInode(ws.id), pid0 = vmPids(ws.id);
  rec("kill: shell window open and health 200", !!shell(app) && (await health(ws.apiPort)) === "200");
  const n = callCount(); killVm(ws.id); const tk = Date.now();
  await sleep(1500);
  await switchWorkspace(app); await sleep(1500); await p.bringToFront().catch(() => {});
  const tl = await watchRows(p, ws.id, 240000, (r, t) => r.k === "here" && t.some((l) => /starting/.test(l)));
  rec("kill: picker row shows 'Starting workspace...'", tl.some((l) => /starting: .*Starting workspace\.\.\./.test(l)), tl.join(" ; "));
  await snap(app, p, "kill-picker-after-recovery");
  rec("kill: health restored without user action", (await waitFor(async () => (await health(ws.apiPort)) === "200", 60000)) !== null, `${((Date.now() - tk) / 1000).toFixed(0)}s after kill`);
  const used = callsSince(n);
  rec("kill: recovery restarted the existing VM (machine start; no init/rm)", /machine start/.test(used) && noDestructive(used));
  rec("kill: same VM disk (inode unchanged), new VM process", diskInode(ws.id).split(" ")[0] === disk0.split(" ")[0] && vmPids(ws.id).length > 0 && vmPids(ws.id).join() !== pid0.join(), `${disk0} -> ${diskInode(ws.id)}`);
  await app.close();
};

// Freeze every process in the core container: container "running" but health fails -> core container restarted, VM untouched.
S.hung = async () => {
  const { app, p, ws } = await bringUp();
  const pid0 = vmPids(ws.id).join(); const n = callCount();
  const ctr = `aw-${ws.id}-workspace`;
  pm(ws.id, ["kill", "--signal", "STOP", ctr]);
  pm(ws.id, ["exec", ctr, "sh", "-c", 'for p in $(ls /proc | grep -E "^[0-9]+$"); do [ "$p" != 1 ] && [ "$p" != "$$" ] && kill -STOP $p 2>/dev/null; done; echo stopped']);
  const tk = Date.now();
  await sleep(2500);
  await switchWorkspace(app); await sleep(1500);
  const state = pm(ws.id, ["inspect", ctr, "--format", "{{.State.Status}}"]);
  rec("hung: core hung (health not 200) while the container reports running", (await health(ws.apiPort)) !== "200" && /running/i.test(state), `state=${state}`);
  const tl = await watchRows(p, ws.id, 240000, (r, t) => r.k === "here" && t.some((l) => /starting/.test(l)));
  rec("hung: row shows 'Starting workspace...' during recovery", tl.some((l) => /Starting workspace\.\.\./.test(l)), tl.join(" ; "));
  rec("hung: health restored", (await waitFor(async () => (await health(ws.apiPort)) === "200", 90000)) !== null, `${((Date.now() - tk) / 1000).toFixed(0)}s`);
  const used = callsSince(n);
  rec("hung: core container restarted, same VM process (no VM restart)", /restart aw-\w+-workspace/.test(used) && !/machine (start|stop|init|rm)/.test(used) && vmPids(ws.id).join() === pid0, `vm pid ${pid0} -> ${vmPids(ws.id).join()}`);
  await snap(app, p, "hung-picker-after-recovery");
  await app.close();
};

// Kill the VM while every `machine start` fails: 3 automatic attempts, then "Needs attention" + Retry; Retry recovers.
S.attention = async () => {
  const { app, p, ws } = await bringUp(true);
  const disk0 = diskInode(ws.id); const n = callCount();
  setMode("startfail"); killVm(ws.id); const tk = Date.now();
  await watchRows(p, ws.id, 420000, (r) => r.k === "attention");
  const att = await rowState(p, ws.id);
  rec("attention: after 3 failed recoveries the row shows 'Needs attention' with Retry", !!att && att.k === "attention" && /needs attention/i.test(att.t) && (await retryBtn(p, ws.id).count()) === 1, `${((Date.now() - tk) / 1000).toFixed(0)}s: ${att?.t}`);
  const t = await snap(app, p, "attention-needs-attention");
  const starts = (callsSince(n).match(/machine start/g) || []).length;
  rec("attention: exactly 3 automatic attempts, then it waits", starts === 3, `machine start calls: ${starts}`);
  await sleep(40000);
  rec("attention: no 4th automatic attempt in 40s", (callsSince(n).match(/machine start/g) || []).length === 3 && (await rowState(p, ws.id))?.k === "attention");
  rec("attention: UI is plain copy, no raw text", !/RAWMARK|gvproxy|krunkit|API_KEY|SECRET123/.test(t));
  const d = diag();
  rec("attention: diagnostics.log has the raw supervisor_recover failures, secret redacted", (d.match(/supervisor_recover code=start_failed/g) || []).length >= 3 && /RAWMARK-startfail/.test(d) && !d.includes(SECRET) && /API_KEY=\[redacted\]/.test(d));
  rec("attention: no VM removal/re-creation in 3 attempts", noDestructive(callsSince(n)) && diskInode(ws.id).split(" ")[0] === disk0.split(" ")[0]);
  setMode("pass"); const n2 = callCount();
  await retryBtn(p, ws.id).click();
  const ok = await waitFor(async () => ((await health(ws.apiPort)) === "200" ? 1 : 0), 300000, 2000);
  await snap(app, p, "attention-after-retry");
  const u2 = callsSince(n2);
  rec("attention: Retry restores the workspace", !!ok);
  rec("attention: Retry recovers the existing VM (machine start, no init/rm), disk preserved", /machine start/.test(u2) && noDestructive(u2) && diskInode(ws.id).split(" ")[0] === disk0.split(" ")[0]);
  await app.close();
};

// SIGKILL the app with the VM running: relaunch stops the orphan and runs no VM until a workspace is picked;
// then a start failure shows plain copy only (raw detail via Copy details, redacted) and Retry brings it up.
S.forcequit = async () => {
  const { app, ws } = await bringUp();
  const pid = await app.evaluate(() => process.pid);
  process.kill(pid, "SIGKILL"); log("SIGKILL main pid", pid);
  await sleep(4000);
  // Orphaned Electron helpers of THIS harness's profile only (matched on its unique --user-data-dir), never the installed app's own.
  const esc = UD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const hp of out("pgrep", ["-f", `--user-data-dir=${esc}`]).split("\n").filter(Boolean)) { try { process.kill(Number(hp), "SIGKILL"); } catch {} }
  await sleep(2000);
  rec("forcequit: force quit left the VM running (orphan)", vmPids(ws.id).length > 0, `krunkit ${vmPids(ws.id).join(",")}`);
  const app2 = await launch(); const p2 = await loginPicker(app2);
  const gone = await waitFor(async () => vmPids(ws.id).length === 0, 180000, 2000);
  const row = await rowState(p2, ws.id);
  await snap(app2, p2, "forcequit-relaunch-no-vm");
  rec("forcequit: relaunch stops the orphaned VM, none runs until a workspace is picked", !!gone && row?.k === "pending", `row=${JSON.stringify(row)} vm=${vmPids(ws.id).join(",") || "none"}`);
  await sleep(40000);
  rec("forcequit: still no VM 40s later (supervisor did not resurrect it)", vmPids(ws.id).length === 0);
  setMode("startfail");
  await p2.evaluate((i) => window.aw.pickWorkspace(i), ws.id);
  const e = p2.locator('[data-testid="bootstrap-error"]');
  await waitFor(async () => (await e.count()) > 0, 120000, 500);
  const msg = await e.innerText().catch(() => "");
  const tt = await snap(app2, p2, "forcequit-start-failed-modal");
  rec("start failed: plain copy only", msg === "The workspace couldn't start. Retry, or copy details for support." && !/RAWMARK|gvproxy|krunkit|API_KEY/.test(tt), JSON.stringify(msg));
  await p2.locator('[data-testid="copy-details"]').click(); await sleep(600);
  const clip = await app2.evaluate(({ clipboard }) => clipboard.readText());
  rec("start failed: Copy details yields the raw detail with the secret redacted", /RAWMARK-startfail/.test(clip) && !clip.includes(SECRET), `${clip.length} bytes`);
  setMode("pass");
  await p2.getByRole("button", { name: "Retry" }).click();
  rec("start failed: Retry brings the workspace up", (await waitFor(async () => shell(app2) && (await health(ws.apiPort)) === "200", 400000, 2000)) !== null);
  await app2.close();
};

// ---- run ----
const hostBefore = await hostState();
log("host state before (must be unchanged after the run):", JSON.stringify(hostBefore));
snapshot();
let ok = false, fatal = null;
try {
  for (const name of PLAN) { log("=== scenario", name); await S[name](); }
  ok = true;
} catch (e) { fatal = e; console.error(e); }
setMode("pass");
// A scenario that threw leaves Electron alive; close it so its VM/front server is released before teardown.
for (const a of [...live]) { try { await a.close(); } catch (e) { console.error(e); } }
if (FLAGS.has("--teardown")) { try { await teardown(); } catch (e) { fatal ??= e; console.error(e); } }
let left = {};
try { left = await leftovers(); } catch (e) { fatal ??= e; console.error(e); }
for (const [k, v] of Object.entries(left)) rec(`leftovers: ${k}`, FLAGS.has("--teardown") ? v.ok : true, v.detail);
let hostErr;
try { hostErr = hostIntegrityError(hostBefore, await hostState()); } catch (e) { hostErr = `host probe threw: ${e}`; }
rec("host integrity: podman-machine-default and :9030 unchanged", hostErr === null, hostErr ?? "");
const final = summary();
if (!FLAGS.has("--teardown")) console.log("(leftovers reported only; re-run with --teardown to clean up and assert they are gone)");
process.exit(ok && final && !fatal ? 0 : 1);
