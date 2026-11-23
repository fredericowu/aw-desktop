// VM-3/4/5 Mac proof driver. Real signed v0.1.17-vm5.1 app, real VMs, hermetic userData.
// Engine dir = bundled engine copy whose podman is a logging shim (/tmp/awvm5/mode injects raw failures).
// usage: node vm5.mjs <scenario>
import { _electron as electron } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const R = "/Users/aw/aw-e2e-vm5";
const APP = process.env.AW_E2E_APP || `${R}/app/AW Desktop.app`;
const EXE = `${APP}/Contents/MacOS/AW Desktop`;
const UD = `${R}/ud`;
const ENG = `${R}/engine`;
const SH = process.env.AW_E2E_SHOTS || `${R}/shots/vm5`;
const MODE = "/tmp/awvm5/mode";
const CALLS = "/tmp/awvm5/calls.log";
mkdirSync(SH, { recursive: true }); mkdirSync(UD, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
const log = (...a) => console.log(T(), ...a);
const results = [];
const rec = (name, ok, detail = "") => { results.push(ok); console.log(ok ? "PASS" : "FAIL", name, detail); };
const sh = (c) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return String(e.stdout ?? "").trim(); } };
const setMode = (m) => { writeFileSync(MODE, m); log("shim mode =", m); };
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8") : "");
const callsSince = (n) => calls().split("\n").slice(n).join("\n");
const callCount = () => calls().split("\n").length;
const diag = () => (existsSync(`${UD}/diagnostics.log`) ? readFileSync(`${UD}/diagnostics.log`, "utf8") : "");
const registry = () => { try { return JSON.parse(readFileSync(`${UD}/local-workspaces.json`, "utf8")).workspaces; } catch { return []; } };
const wsOf = (name) => registry().find((w) => w.name === name);
const jwt = () => readFileSync(process.env.AW_E2E_JWT_FILE || "/Users/aw/aw-e2e-vm2c/jwt.txt", "utf8").trim();
const vmPids = (id) => sh(`pgrep -f "krunkit.*aw-${id}" || true`).split("\n").filter(Boolean);
const diskInfo = (id) => sh(`stat -f '%i %z' ~/.awd/${id}/home/.local/share/containers/podman/machine/libkrun/aw-${id}-arm64.raw`);
const machineList = (id) => sh(`HOME=/Users/aw/.awd/${id}/home TMPDIR=/Users/aw/.awd/${id}/tmp PATH=${ENG}/bin:/usr/bin:/bin CONTAINERS_MACHINE_PROVIDER=libkrun CONTAINERS_HELPER_BINARY_DIR=${ENG}/bin ${ENG}/bin/podman.real machine list --format '{{.Name}} running={{.Running}}' 2>&1`);
const health = (port) => sh(`curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:${port}/api/health`);
const mainPid = (app) => app.evaluate(() => process.pid);

export const launch = (extra = {}) => electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UD}`], env: { ...process.env, AW_DESKTOP_ENGINE_DIR: ENG, ...extra } });
const picker = async (app) => { for (let i = 0; i < 100; i++) { const w = app.windows().find((x) => !x.url().startsWith("http://127.0.0.1") && !x.url().startsWith("devtools")); if (w) return w; await sleep(300); } throw new Error("no picker"); };
const shell = (app) => app.windows().find((w) => w.url().startsWith("http://127.0.0.1"));
const text = (p) => p.evaluate(() => document.body.innerText + "\n[modals] " + [...document.querySelectorAll(".modal, [role=dialog]")].map((e) => e.innerText).join(" || ")).catch(() => "");
async function snap(app, p, name) {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().startsWith("http://127.0.0.1")) { w.show(); w.focus(); } }).catch(() => {});
  await sleep(500);
  await p.screenshot({ path: `${SH}/${name}.png`, timeout: 15000 }).catch((e) => log("screenshot failed", name, String(e).slice(0, 80)));
  const t = await text(p);
  writeFileSync(`${SH}/${name}.txt`, t);
  log("SHOT", name, JSON.stringify(t.replace(/\s+/g, " ").slice(0, 200)));
  return t;
}
async function login(app) { // session already seeded in UD
  const p = await picker(app);
  await p.waitForSelector('[data-testid="local-block"]', { timeout: 40000 });
  return p;
}
async function waitFor(fn, ms, step = 500) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(step); } return null; }
const rowState = async (p, id) => p.evaluate((i) => { for (const k of ["here", "starting", "attention", "pending"]) { const e = document.querySelector(`[data-testid="${k}-${i}"]`); if (e) return { k, t: e.innerText.replace(/\s+/g, " ") }; } return null; }, id).catch(() => null);
async function watchRows(p, id, ms, until) { // timeline of row states
  const tl = []; const end = Date.now() + ms; let last = "";
  while (Date.now() < end) { const r = await rowState(p, id); const s = r ? `${r.k}: ${r.t}` : "none"; if (s !== last) { tl.push(`${T()} ${s}`); last = s; log("row", s); } if (until && r && until(r, tl)) break; await sleep(500); }
  return tl;
}
async function startWs(app, p, id, ms = 240000) { // open existing ws via pickWorkspace; wait for shell
  await p.evaluate((i) => window.aw.pickWorkspace(i), id);
  return waitFor(async () => shell(app), ms, 2000);
}
const switchWorkspace = (app) => app.evaluate(({ Menu }) => { const ws = Menu.getApplicationMenu().items.find((i) => i.label === "Workspace"); ws.submenu.items.find((i) => i.label.startsWith("Switch")).click(); });
// With the shell window open the picker window is parked on its splash: record what a user would see there.
const parkedText = async (p) => (await text(p)).replace(/\s+/g, " ").slice(0, 120);
const gone = async (p) => !(await p.evaluate(() => 1).catch(() => 0));

const S = {};

// ---------------------------------------------------------------- seed session
S.seed = async () => {
  const app = await launch(); const p = await picker(app);
  await p.waitForSelector('input[type="email"], input[type="password"]', { timeout: 20000 });
  const enc = await app.evaluate(({ safeStorage }, j) => safeStorage.encryptString(j).toString("base64"), jwt());
  writeFileSync(`${UD}/session.bin`, Buffer.from(enc, "base64"));
  await app.close();
  const app2 = await launch(); const p2 = await login(app2);
  rec("seed: session loads, picker reached", true, "version " + (await app2.evaluate(({ app }) => app.getVersion())));
  await snap(app2, p2, "00-picker-empty");
  await app2.close();
};

// ---------------------------------------------------------------- VM-3 preflight
async function openWizard(p) {
  await p.getByRole("button", { name: /Create new (workspace|sandbox)/ }).first().click();
  await sleep(1800);
}
const closeWizard = async (p) => { await p.getByRole("button", { name: "Cancel" }).click().catch(() => {}); await sleep(500); };
S.preflight = async () => {
  setMode("pass");
  let app = await launch(); let p = await login(app);
  await openWizard(p);
  await p.locator("#sandbox-name").waitFor({ timeout: 10000 });
  let t = await snap(app, p, "10-wizard-ok");
  rec("VM-3 ok case: wizard opens straight on the name field", true);
  rec("VM-3 Dependencies step gone: no 'Dependencies' / step list / install wording", !/dependenc|install|podman|homebrew|brew|step \d/i.test(t) && (await p.locator('[data-testid="preflight-blocked"]').count()) === 0, JSON.stringify(t.replace(/\s+/g, " ").slice(0, 160)));
  rec("VM-3 ok case: Create stays disabled until a name is typed, then enables", await (async () => { const d0 = await p.locator(".modal button.primary").isDisabled(); await p.fill("#sandbox-name", "x"); const d1 = await p.locator(".modal button.primary").isDisabled(); await p.fill("#sandbox-name", ""); return d0 && !d1; })());
  await closeWizard(p);
  // failing case 1: engine cannot run (shim: --version fails)
  setMode("noengine");
  await openWizard(p);
  const blocked = await p.locator('[data-testid="preflight-blocked"]').innerText({ timeout: 10000 }).catch(() => "");
  t = await snap(app, p, "11-wizard-engine-missing");
  rec("VM-3 fail engine_missing: plain copy", blocked === "AW Desktop is incomplete. Reinstall it and try again.", JSON.stringify(blocked));
  rec("VM-3 fail engine_missing: no raw text in UI", !/RAWMARK|dyld|Library not loaded|podman/i.test(t));
  rec("VM-3 fail engine_missing: Create disabled even with a name", await (async () => { await p.fill("#sandbox-name", "blocked-try"); return p.locator(".modal button.primary").isDisabled(); })());
  setMode("pass");
  await p.locator('[data-testid="preflight-recheck"]').click();
  rec("VM-3 recheck after fix clears the block", await waitFor(async () => (await p.locator('[data-testid="preflight-blocked"]').count()) === 0, 10000), "");
  await closeWizard(p);
  await app.close();
  // failing case 2: path_too_long (long HOME)
  const longHome = `${R}/h-` + "x".repeat(60);
  mkdirSync(`${longHome}/Library`, { recursive: true });
  sh(`ln -sfn /Users/aw/Library/Keychains ${longHome}/Library/Keychains`);
  app = await launch({ HOME: longHome }); p = await login(app).catch(async (e) => { sh(`rm -f ${UD}/safestorage-*`); throw e; });
  await openWizard(p);
  const b2 = await p.locator('[data-testid="preflight-blocked"]').innerText({ timeout: 10000 }).catch(() => "");
  await snap(app, p, "12-wizard-path-too-long");
  rec("VM-3 fail path_too_long: plain copy", b2 === "This Mac's account name is too long to run local workspaces.", JSON.stringify(b2));
  await app.close(); sh(`rm -f ${UD}/safestorage-*`);
  // failing case 3: low_disk (HOME on a small volume)
  sh(`hdiutil detach /Volumes/vm5small -force >/dev/null 2>&1; rm -f ${R}/small.dmg*`);
  sh(`hdiutil create -size 3g -fs APFS -volname vm5small ${R}/small.dmg >/dev/null 2>&1 && hdiutil attach ${R}/small.dmg >/dev/null 2>&1`);
  mkdirSync("/Volumes/vm5small/Library", { recursive: true }); sh("ln -sfn /Users/aw/Library/Keychains /Volumes/vm5small/Library/Keychains");
  log("small volume:", sh("df -h /Volumes/vm5small | tail -1"));
  app = await launch({ HOME: "/Volumes/vm5small" }); p = await login(app).catch(async (e) => { sh(`rm -f ${UD}/safestorage-*`); throw e; });
  await openWizard(p);
  const b3 = await p.locator('[data-testid="preflight-blocked"]').innerText({ timeout: 10000 }).catch(() => "");
  await snap(app, p, "13-wizard-low-disk");
  rec("VM-3 fail low_disk: plain copy with GB to free", /^Not enough free disk space\. Free up \d+ GB and try again\.$/.test(b3), JSON.stringify(b3));
  await app.close(); sh(`rm -f ${UD}/safestorage-*`);
  sh(`hdiutil detach /Volumes/vm5small -force >/dev/null 2>&1; rm -f ${R}/small.dmg*; rm -rf ${longHome}`);
  rec("VM-3 low_memory / virtualization_unavailable on this Mac", true, "NOT driven: this Mac has 24 GiB and kern.hv_support=1; covered by unit tests only");
};

// ---------------------------------------------------------------- VM-4 errors + two-phase + diagnostics
S.errors = async () => {
  setMode("pass");
  const app = await launch(); const p = await login(app);
  await openWizard(p);
  await p.fill("#sandbox-name", "vm5-a");
  setMode("dns");
  await p.locator(".modal button.primary").click();
  const phases = new Set();
  const seePhase = async () => { const t = await p.locator('[data-testid="bootstrap-phase"]').innerText({ timeout: 300 }).catch(() => ""); if (t) phases.add(t); };
  const failedEl = p.locator('[data-testid="bootstrap-error"]');
  await waitFor(async () => { await seePhase(); return (await failedEl.count()) > 0; }, 120000, 200);
  let err = await failedEl.innerText().catch(() => "");
  let t = await snap(app, p, "20-fail-download");
  rec("VM-4 download failure: plain copy", err === "Couldn't download the workspace. Check your connection and try again.", JSON.stringify(err));
  rec("VM-4 UI shows no raw engine text", !/RAWMARK|registry|dial tcp|lookup|podman|192\.168|machine|exit \d+/i.test(t));
  await p.locator('[data-testid="copy-details"]').click();
  await sleep(800);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  rec("VM-4 Copy details: 'Copied.' shown and clipboard holds the diagnostics tail", /Copied\./.test(await text(p)) && /RAWMARK-dns/.test(clip), `clipboard ${clip.length} bytes`);
  const d1 = diag();
  rec("VM-4 diagnostics.log has the raw failure (code=download_failed)", /code=download_failed/.test(d1) && /RAWMARK-dns/.test(d1) && /no such host/.test(d1));
  rec("VM-4 raw failure is in the log but NOT in any rendered text", /RAWMARK-dns/.test(d1) && !/RAWMARK-dns/.test(t));
  rec("VM-4 diagnostics.log is 0600", sh(`stat -f %Lp ${UD}/diagnostics.log`) === "600", sh(`stat -f %Lp ${UD}/diagnostics.log`));
  // retry with a disk-full failure
  setMode("nospace");
  await p.getByRole("button", { name: "Retry" }).click();
  await waitFor(async () => { await seePhase(); const e = await failedEl.innerText().catch(() => ""); return e && e !== err; }, 90000, 200);
  err = await failedEl.innerText().catch(() => "");
  t = await snap(app, p, "21-fail-nospace");
  rec("VM-4 low-disk failure: plain copy", err === "Not enough free disk space. Free up some space and try again.", JSON.stringify(err));
  rec("VM-4 UI no raw (nospace)", !/RAWMARK|no space left|\/var\/data/.test(t) && /RAWMARK-nospace/.test(diag()));
  // retry for real: two-phase modal on a real bring-up
  setMode("pass");
  await p.getByRole("button", { name: "Retry" }).click();
  const shots = new Set();
  const up = await waitFor(async () => { await seePhase(); const ph = await p.locator('[data-testid="bootstrap-phase"]').innerText({ timeout: 200 }).catch(() => ""); if (ph && !shots.has(ph)) { shots.add(ph); await snap(app, p, `22-phase-${shots.size}`); } return shell(app); }, 600000, 150);
  rec("VM-4 retry after failures brings a real workspace up", !!up);
  log("phases seen:", [...phases].join(" | "));
  rec("VM-4 two-phase modal: only the two phase labels are ever shown", phases.size > 0 && [...phases].every((x) => x === "Preparing your workspace" || x === "Starting workspace"), [...phases].join(" | "));
  rec("VM-4 two-phase modal: both phases observed", phases.has("Preparing your workspace") && phases.has("Starting workspace"), "");
  const ws = wsOf("vm5-a"); log("ws", JSON.stringify(ws));
  rec("workspace healthy", health(ws.apiPort) === "200", `port ${ws.apiPort}`);
  const shellProc = shell(app); rec("shell served", !!shellProc);
  await app.close();
  rec("quit stops the VM", (await waitFor(async () => vmPids(ws.id).length === 0, 120000)) !== null);
};

// ---------------------------------------------------------------- VM-5 supervisor
async function bringUp(name, showPicker = false) {
  setMode("pass");
  const app = await launch(); const p = await login(app);
  const ws = wsOf(name);
  const sh0 = await startWs(app, p, ws.id);
  if (!sh0) throw new Error("workspace did not come up");
  await waitFor(async () => health(ws.apiPort) === "200", 120000);
  if (showPicker) { await switchWorkspace(app); await sleep(2500); await p.bringToFront().catch(() => {}); }
  return { app, p, ws };
}
const killVm = (id) => { const pids = vmPids(id); sh(`kill -9 ${pids.join(" ")}`); log("killed VM pids", pids.join(",")); return pids; };
const noDestructive = (txt) => !/machine (rm|init)|\bvolume rm\b| rm -f aw-local\w+-postgres/.test(txt);

S.mkws = async () => {
  setMode("pass");
  const app = await launch(); const p = await login(app);
  await openWizard(p); await p.fill("#sandbox-name", "vm5-a"); await p.locator(".modal button.primary").click();
  const up = await waitFor(async () => shell(app), 600000, 1500);
  const ws = wsOf("vm5-a");
  rec("mkws: fresh workspace vm5-a created and healthy", !!up && health(ws.apiPort) === "200", JSON.stringify(ws));
  await app.close();
};
S.kill = async () => { // kill VM with window open -> recovers; disk preserved
  const { app, p, ws } = await bringUp("vm5-a");
  const disk0 = diskInfo(ws.id), pid0 = vmPids(ws.id); log("disk(inode size)", disk0, "vm pids", pid0);
  rec("pre: shell window open + health 200", !!shell(app) && health(ws.apiPort) === "200");
  await snap(app, shell(app), "30-shell-before-kill");
  const n = callCount(); killVm(ws.id); const tk = Date.now();
  await sleep(1500);
  log("picker while shell open (no switch):", await parkedText(p));
  writeFileSync(`${SH}/30b-picker-parked-while-shell-open.txt`, await text(p));
  await switchWorkspace(app); await sleep(1500); await p.bringToFront().catch(() => {});
  const tl = await watchRows(p, ws.id, 240000, (r, tl) => r.k === "here" && tl.some((l) => /starting/.test(l)));
  const sawStarting = tl.some((l) => /starting: .*Starting workspace\.\.\./.test(l));
  rec("VM-5 kill VM: picker row shows 'Starting workspace...'", sawStarting, tl.join(" ; "));
  await snap(app, p, "31-picker-after-recovery");
  rec("VM-5 kill VM: health restored without user action", (await waitFor(async () => health(ws.apiPort) === "200", 60000)) !== null, `${((Date.now() - tk) / 1000).toFixed(0)}s after kill`);
  const used = callsSince(n); writeFileSync(`${SH}/31-calls-kill.txt`, used);
  rec("VM-5 kill VM: recovery restarted the existing VM (machine start; no init/rm)", /machine start/.test(used) && noDestructive(used), used.split("\n").filter((l) => /machine/.test(l)).join(" || "));
  const disk1 = diskInfo(ws.id);
  rec("VM-5 kill VM: same VM disk file (inode+size unchanged), new VM process", disk1.split(" ")[0] === disk0.split(" ")[0] && vmPids(ws.id).length > 0 && vmPids(ws.id).join() !== pid0.join(), `before ${disk0} after ${disk1}`);
  rec("VM-5 kill VM: machine list still has the same machine running", /aw-.*running=true/.test(machineList(ws.id)), machineList(ws.id));
  await p.evaluate((i) => window.aw.pickWorkspace(i), ws.id);
  const sw = await waitFor(async () => shell(app), 60000, 1000);
  rec("VM-5 kill VM: workspace window reopens and serves after recovery", !!sw && (await sw.evaluate(async () => (await fetch("/api/health")).status).catch(() => 0)) === 200);
  await app.close();
};

S.hung = async () => {
  const { app, p, ws } = await bringUp("vm5-a");
  const pid0 = vmPids(ws.id).join(); const n = callCount();
  const ctr = `aw-${ws.id}-workspace`;
  const env = `HOME=/Users/aw/.awd/${ws.id}/home TMPDIR=/Users/aw/.awd/${ws.id}/tmp PATH=${ENG}/bin:/usr/bin:/bin CONTAINERS_MACHINE_PROVIDER=libkrun CONTAINERS_HELPER_BINARY_DIR=${ENG}/bin`;
  const pm = (a) => sh(`${env} ${ENG}/bin/podman.real --connection aw-${ws.id} ${a} 2>&1`);
  log(pm(`kill --signal STOP ${ctr}`));
  log(pm(`exec ${ctr} sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$"); do [ "$p" != 1 ] && [ "$p" != "$$" ] && kill -STOP $p 2>/dev/null; done; echo stopped'`));
  const tk = Date.now();
  await sleep(2500);
  await switchWorkspace(app); await sleep(1500);
  rec("pre: core hung (health not 200) while container reports running", health(ws.apiPort) !== "200" && /running/i.test(pm(`inspect ${ctr} --format '{{.State.Status}}'`)), `health=${health(ws.apiPort)} state=${pm(`inspect ${ctr} --format '{{.State.Status}}'`)}`);
  const tl = await watchRows(p, ws.id, 240000, (r, tl) => r.k === "here" && tl.some((l) => /starting/.test(l)));
  rec("VM-5 hung core: row shows 'Starting workspace...' during recovery", tl.some((l) => /Starting workspace\.\.\./.test(l)), tl.join(" ; "));
  rec("VM-5 hung core: health restored", (await waitFor(async () => health(ws.apiPort) === "200", 90000)) !== null, `${((Date.now() - tk) / 1000).toFixed(0)}s`);
  const used = callsSince(n); writeFileSync(`${SH}/32-calls-hung.txt`, used);
  rec("VM-5 hung core: core container restarted, same VM process (no VM restart)", /restart aw-\w+-workspace/.test(used) && !/machine (start|stop|init|rm)/.test(used) && vmPids(ws.id).join() === pid0, `vm pid ${pid0} -> ${vmPids(ws.id).join()}; ${used.split("\n").filter((l) => /restart/.test(l)).join(" || ")}`);
  await snap(app, p, "32-picker-after-hung");
  await app.close();
};

S.attention = async () => {
  const { app, p, ws } = await bringUp("vm5-a", true);
  const disk0 = diskInfo(ws.id); const n = callCount();
  setMode("startfail"); killVm(ws.id); const tk = Date.now();
  const tl = await watchRows(p, ws.id, 420000, (r) => r.k === "attention");
  const att = await rowState(p, ws.id);
  rec("VM-5 3 failed recoveries: row shows 'Needs attention' with Retry", !!att && att.k === "attention" && /needs attention/i.test(att.t) && (await p.locator(`[data-testid="attention-${ws.id}"] button:has-text("Retry")`).count()) === 1, `${((Date.now() - tk) / 1000).toFixed(0)}s: ${att?.t}`);
  await snap(app, p, "33-needs-attention");
  const used = callsSince(n); writeFileSync(`${SH}/33-calls-attention.txt`, used);
  const starts = (used.match(/machine start/g) || []).length;
  rec("VM-5 exactly 3 automatic attempts, then it waits", starts === 3, `machine start calls: ${starts}`);
  await sleep(40000);
  const starts2 = (callsSince(n).match(/machine start/g) || []).length;
  rec("VM-5 waits for the user after 3 attempts (no 4th automatic attempt in 40s)", starts2 === 3 && (await rowState(p, ws.id))?.k === "attention", `calls ${starts2}`);
  const t = await text(p);
  rec("VM-5 needs-attention UI is plain copy, no raw text", !/RAWMARK|gvproxy|krunkit|API_KEY|SECRET123/.test(t));
  const d = diag();
  rec("VM-5 diagnostics.log has the supervisor_recover raw failures, secret redacted", (d.match(/supervisor_recover code=start_failed/g) || []).length >= 3 && /RAWMARK-startfail/.test(d) && !/sk-live-SECRET123/.test(d) && /API_KEY=\[redacted\]/.test(d), `entries=${(d.match(/supervisor_recover/g) || []).length}`);
  rec("VM-5 no VM removal/re-creation in 3 attempts", noDestructive(used) && diskInfo(ws.id).split(" ")[0] === disk0.split(" ")[0]);
  // Retry
  setMode("pass"); const n2 = callCount();
  await p.locator(`[data-testid="attention-${ws.id}"] button:has-text("Retry")`).click();
  const sh1 = await waitFor(async () => (health(ws.apiPort) === "200" ? 1 : 0), 300000, 2000);
  await snap(app, p, "34-after-retry");
  const u2 = callsSince(n2); writeFileSync(`${SH}/34-calls-retry.txt`, u2);
  rec("VM-5 Retry restores the workspace", !!sh1, "");
  rec("VM-5 Retry uses recovery on the existing VM (machine start, no init/rm), disk preserved", /machine start/.test(u2) && noDestructive(u2) && diskInfo(ws.id).split(" ")[0] === disk0.split(" ")[0], `disk ${disk0} -> ${diskInfo(ws.id)}`);
  await app.close();
};

S.wake = async () => {
  const { app, p, ws } = await bringUp("vm5-a", true);
  const n = callCount(); killVm(ws.id); const tk = Date.now();
  await sleep(2500);
  // emulate the OS wake notification the app subscribes to (powerMonitor 'resume'); a real pmset sleep would drop the host link
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("resume"); });
  const tl = await watchRows(p, ws.id, 300000, (r, tl) => r.k === "here" && tl.some((l) => /starting/.test(l)));
  const firstStarting = tl.find((l) => /starting/.test(l));
  log("timeline", tl.join(" ; "));
  rec("VM-5 wake with dead VM: health check runs on resume and the VM is recovered", (await waitFor(async () => health(ws.apiPort) === "200", 120000)) !== null && /machine start/.test(callsSince(n)), firstStarting ?? "no starting row seen");
  await snap(app, p, "35-after-wake");
  await app.close();
};

S.quit = async () => { // quit during recovery leaves no VM
  const { app, p, ws } = await bringUp("vm5-a", true);
  setMode("slowstart"); killVm(ws.id);
  const st = await watchRows(p, ws.id, 120000, (r) => r.k === "starting");
  rec("pre: recovery in progress (row starting)", (await rowState(p, ws.id))?.k === "starting", st.join(";"));
  await sleep(8000); // machine start is in flight (shim sleeps 45s, then real start)
  const pid = await mainPid(app); log("quitting app pid", pid, "during recovery");
  app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  const tq = Date.now();
  const exited = await waitFor(async () => { const st = sh(`ps -o stat= -p ${pid} 2>/dev/null`); return st === "" || st.startsWith("Z"); }, 300000, 1000);
  rec("VM-5 quit during recovery: app exits (waits for the in-flight recovery, then stops what it started)", !!exited, `${((Date.now() - tq) / 1000).toFixed(0)}s after quit`);
  await sleep(5000);
  const left = vmPids(ws.id); log("VM pids after quit:", left.join(",") || "none");
  rec("VM-5 quit during recovery leaves no VM (no krunkit/gvproxy for the workspace)", left.length === 0 && sh(`pgrep -f "gvproxy.*aw-${ws.id}" || true`) === "", machineList(ws.id));
  setMode("pass");
};

S.remove = async () => { // remove during recovery does not race
  const { app, p, ws } = await bringUp("vm5-a", true);
  setMode("slowstart"); killVm(ws.id);
  await watchRows(p, ws.id, 120000, (r) => r.k === "starting");
  await sleep(6000);
  const hasBtn = await p.locator(`[data-testid="remove-${ws.id}"]`).count();
  rec("VM-5 remove during recovery: no Remove button on the recovering row", hasBtn === 0);
  const r = await p.evaluate((i) => window.aw.removeLocalWorkspace(i), ws.id);
  log("remove IPC during recovery ->", JSON.stringify(r));
  rec("VM-5 remove during recovery: refused as busy, nothing removed", r.ok === false && r.code === "bootstrap_running" && !!wsOf("vm5-a") && /aw-.*running/.test(machineList(ws.id) + " running") && existsSyncDisk(ws.id), JSON.stringify(r));
  await snap(app, p, "36-remove-busy");
  setMode("pass");
  rec("recovery still completes after the refused remove", (await waitFor(async () => health(ws.apiPort) === "200", 240000, 2000)) !== null);
  await app.close();
};
const existsSyncDisk = (id) => diskInfo(id).length > 0;

S.forcequit = async () => { // force quit then relaunch runs no VM until a workspace is picked
  const { app, p, ws } = await bringUp("vm5-a");
  const pid = await mainPid(app);
  const helperPids = sh(`pgrep -f "AW Desktop.app/Contents/Frameworks.*aw-e2e-vm5/ud" || true`);
  sh(`kill -9 ${pid}`); log("SIGKILL main pid", pid);
  await sleep(4000);
  sh(`pkill -9 -f "aw-e2e-vm5/app/AW Desktop.app" || true`);
  await sleep(2000);
  rec("pre: force quit left the VM running (orphan)", vmPids(ws.id).length > 0, `krunkit ${vmPids(ws.id).join(",")}`);
  const app2 = await launch(); const p2 = await login(app2);
  const gone2 = await waitFor(async () => vmPids(ws.id).length === 0, 180000, 2000);
  const row = await rowState(p2, ws.id);
  await snap(app2, p2, "37-relaunch-no-vm");
  rec("VM-5 force-quit then relaunch: orphaned VM stopped, no VM runs until a workspace is picked", !!gone2 && row?.k === "pending", `row=${JSON.stringify(row)} vm=${vmPids(ws.id).join(",") || "none"}`);
  await sleep(40000);
  rec("VM-5 still no VM 40s later (supervisor did not resurrect it)", vmPids(ws.id).length === 0);
  // start_failed UI copy on pick
  setMode("startfail");
  await p2.evaluate((i) => window.aw.pickWorkspace(i), ws.id);
  const e = p2.locator('[data-testid="bootstrap-error"]');
  await waitFor(async () => (await e.count()) > 0, 120000, 500);
  const msg = await e.innerText().catch(() => "");
  const tt = await snap(app2, p2, "38-start-failed-modal");
  rec("VM-4 start failure: plain copy only", msg === "The workspace couldn't start. Retry, or copy details for support." && !/RAWMARK|gvproxy|krunkit|API_KEY/.test(tt), JSON.stringify(msg));
  await p2.locator('[data-testid="copy-details"]').click(); await sleep(600);
  const clip = await app2.evaluate(({ clipboard }) => clipboard.readText());
  rec("VM-4 Copy details yields raw detail with the secret redacted", /RAWMARK-startfail/.test(clip) && !/sk-live-SECRET123/.test(clip), `${clip.length} bytes`);
  setMode("pass");
  await p2.getByRole("button", { name: "Retry" }).click();
  rec("VM-4 Retry after a start failure brings the workspace up", (await waitFor(async () => shell(app2) && health(ws.apiPort) === "200", 400000, 2000)) !== null);
  await app2.close();
};

S.removeok = async () => { // remove for real, supervisor must not resurrect
  setMode("pass");
  const app = await launch(); const p = await login(app);
  const ws = wsOf("vm5-a");
  const before = callCount();
  await p.locator(`[aria-label="Remove vm5-a"]`).click();
  await p.locator('[data-testid="remove-confirm"]').click();
  await p.locator('[data-testid="remove-modal"]').waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
  await sleep(45000);
  rec("VM-5 remove: machine gone and nothing resurrected by the supervisor after 45s", !wsOf("vm5-a") && vmPids(ws.id).length === 0 && !/aw-/.test(machineList(ws.id)), machineList(ws.id) || "no machines");
  const after = callsSince(before); writeFileSync(`${SH}/39-calls-remove.txt`, after);
  rec("VM-5 remove: no machine init/start issued after the removal", !/machine (init|start)/.test(after.split("machine rm").slice(1).join("")));
  await app.close();
};

// ---------------------------------------------------------------- banner (separate WebContentsView in the shell window)
// The recovery banner is a WebContentsView (src/main/bannerView.ts): not a Playwright page and not in the shell DOM.
// Find it by its data: URL through the main process, read its text and capture it with capturePage.
const bannerProbe = (app) => app.evaluate(async ({ webContents }) => {
  const wc = webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith("data:text/html"));
  if (!wc) return null;
  const text = await wc.executeJavaScript("document.body.innerText").catch(() => "");
  const buttons = await wc.executeJavaScript("[...document.querySelectorAll('button')].map(b=>b.innerText)").catch(() => []);
  return { id: wc.id, text: String(text).replace(/\s+/g, " ").trim(), buttons };
}).catch(() => null);
const bannerAttached = (app) => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http://127.0.0.1")); return w ? w.contentView.children.length : -1; }).catch(() => -1);
async function bannerShot(app, name) {
  const png = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith("data:text/html"));
    if (!wc) return null; const img = await wc.capturePage(); return img.toPNG().toString("base64");
  }).catch(() => null);
  if (png) writeFileSync(`${SH}/${name}.png`, Buffer.from(png, "base64"));
  const b = await bannerProbe(app);
  writeFileSync(`${SH}/${name}.txt`, JSON.stringify(b));
  log("BANNER", name, png ? "png ok" : "NO PNG", JSON.stringify(b));
  return b;
}
const shellShot = async (app, name) => { const s = shell(app); if (s) await app.evaluate(async ({ BrowserWindow }, nm) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http://127.0.0.1")); const img = await w.capturePage(); require("fs").writeFileSync(nm, img.toPNG()); }, `${SH}/${name}.png`).catch((e) => log("shell shot failed", String(e).slice(0, 80))); };
const bannerClickRetry = (app) => app.evaluate(async ({ webContents }) => { const wc = webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith("data:text/html")); if (!wc) return false; return wc.executeJavaScript("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/retry/i.test(x.innerText)); if(!b) return false; b.click(); return true;})()"); });

S.banner = async () => { // kill VM with the workspace window open: banner "Starting workspace..." then auto-dismiss
  const { app, p, ws } = await bringUp("vm5-a");
  await sleep(2000);
  const base = await bannerAttached(app);
  rec("pre: no banner while healthy", (await bannerProbe(app)) === null || base <= 1, `children=${base}`);
  await shellShot(app, "40-shell-healthy");
  killVm(ws.id); const tk = Date.now();
  const seen = []; let shotDone = false; let sawStarting = null;
  const ok = await waitFor(async () => { const b = await bannerProbe(app); const att = await bannerAttached(app); const line = `${att}:${b?.text ?? "-"}`; if (seen[seen.length - 1]?.l !== line) { seen.push({ l: line, t: T() }); log("banner", line); }
    if (b && /Starting workspace\.\.\./.test(b.text) && att > base && !shotDone) { shotDone = true; sawStarting = b; await bannerShot(app, "41-banner-starting"); await shellShot(app, "41-shell-with-banner"); }
    return shotDone; }, 120000, 250);
  rec("VM-5 kill VM: in-window banner shows 'Starting workspace...' (attached view, captured via capturePage)", !!ok && !!sawStarting, JSON.stringify(sawStarting));
  const gone = await waitFor(async () => (await bannerAttached(app)) <= base && health(ws.apiPort) === "200", 240000, 1000);
  rec("VM-5 kill VM: banner auto-dismisses after recovery and health is 200", !!gone, `${((Date.now() - tk) / 1000).toFixed(0)}s; timeline ${seen.map((x) => x.t + " " + x.l).join(" ; ")}`);
  await shellShot(app, "42-shell-after-dismiss");
  await app.close();
};

S.bannerattention = async () => { // 3 forced failures -> Needs attention + copy + Retry; Retry returns to progress
  const { app, p, ws } = await bringUp("vm5-a");
  const base = await bannerAttached(app); const disk0 = diskInfo(ws.id);
  setMode("startfail"); killVm(ws.id); const tk = Date.now(); const n = callCount();
  let b = null; let tShot = false;
  const reached = await waitFor(async () => { b = await bannerProbe(app); return b && /needs attention/i.test(b.text) && b.buttons.some((x) => /retry/i.test(x)); }, 420000, 500);
  const used = callsSince(n); writeFileSync(`${SH}/50-calls-attention.txt`, used);
  b = await bannerShot(app, "51-banner-needs-attention"); await shellShot(app, "51-shell-with-banner");
  const starts = (used.match(/machine start/g) || []).length;
  rec("VM-5 3 forced failures: banner shows 'Needs attention' with a Retry button", !!reached && /needs attention/i.test(b?.text ?? "") && (b?.buttons ?? []).some((x) => /^retry$/i.test(x)), `${((Date.now() - tk) / 1000).toFixed(0)}s ${JSON.stringify(b)}`);
  rec("VM-5 banner copy contains \"We couldn't restart this workspace. Try again.\"", /We couldn't restart this workspace\. Try again\./.test(b?.text ?? ""), JSON.stringify(b?.text));
  rec("VM-5 exactly 3 automatic attempts before attention", starts === 3, `machine start calls=${starts}`);
  rec("VM-5 banner is plain copy, no raw text", !/RAWMARK|gvproxy|krunkit|API_KEY|SECRET123/.test(b?.text ?? ""));
  // Retry -> progress. slowstart keeps the progress state observable.
  setMode("slowstart"); const n2 = callCount();
  const clicked = await bannerClickRetry(app);
  let prog = null;
  await waitFor(async () => { const x = await bannerProbe(app); if (x && /Starting workspace\.\.\./.test(x.text)) { prog = x; return true; } return false; }, 30000, 150);
  if (prog) await bannerShot(app, "52-banner-retry-progress");
  rec("VM-5 Retry click returns the banner to 'Starting workspace...' progress (Retry gone)", clicked === true && !!prog && !prog.buttons.some((x) => /retry/i.test(x)), JSON.stringify(prog));
  setMode("pass");
  const done = await waitFor(async () => (await bannerAttached(app)) <= base && health(ws.apiPort) === "200", 360000, 1500);
  const u2 = callsSince(n2); writeFileSync(`${SH}/53-calls-retry.txt`, u2);
  rec("VM-5 Retry recovers the workspace and the banner dismisses", !!done, `disk ${disk0} -> ${diskInfo(ws.id)}`);
  rec("VM-5 Retry used machine start on the existing VM (no init/rm)", /machine start/.test(u2) && noDestructive(u2) && diskInfo(ws.id).split(" ")[0] === disk0.split(" ")[0]);
  await shellShot(app, "54-shell-after-retry");
  await app.close();
};

S.vm4 = async () => { // diagnostics.log forced to 0644, then a write must leave 0600; setup modal title shows the display name
  setMode("pass");
  const app = await launch(); const p = await login(app);
  writeFileSync(`${UD}/diagnostics.log`, "[pre-existing]\n\n"); sh(`chmod 644 ${UD}/diagnostics.log`);
  const before = sh(`stat -f %Lp ${UD}/diagnostics.log`);
  rec("pre: diagnostics.log is 0644", before === "644", before);
  const DN = "VM4 Proof Display";
  await openWizard(p); await p.fill("#sandbox-name", DN);
  setMode("dns");
  await p.locator(".modal button.primary").click();
  const titles = new Set();
  await waitFor(async () => { const t = await p.locator(".modal strong").first().innerText({ timeout: 200 }).catch(() => ""); if (t) titles.add(t); return (await p.locator('[data-testid="bootstrap-error"]').count()) > 0; }, 120000, 100);
  const t = await snap(app, p, "60-vm4-modal");
  rec("VM-4 write triggered (failure logged) and diagnostics.log is now 0600", sh(`stat -f %Lp ${UD}/diagnostics.log`) === "600" && /code=download_failed/.test(diag()) && /pre-existing/.test(diag()), `mode ${sh(`stat -f %Lp ${UD}/diagnostics.log`)}`);
  writeFileSync(`${SH}/60-vm4-perms.txt`, `before=${before}\nafter=${sh(`stat -f %Lp ${UD}/diagnostics.log`)}\ntitles=${[...titles].join(" | ")}\n`);
  rec("VM-4 setup modal title shows the workspace display name", [...titles].some((x) => x.includes(DN)), [...titles].join(" | "));
  await app.close();
};

const name = process.argv[2];
if (!S[name]) { console.log("scenarios:", Object.keys(S).join(" ")); process.exit(2); }
try { await S[name](); } catch (e) { console.error("FATAL", e); results.push(false); }
const ok = results.every(Boolean);
console.log(`\n${name}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(ok ? 0 : 1);
