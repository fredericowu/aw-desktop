// Phase E e2e: drives the REAL installed AW Desktop.app (Playwright _electron) through the
// standalone local-workspace path against real podman. Needs a logged-in macOS GUI session.
// Usage: AW_E2E_JWT_FILE=<file> node e2e/phaseE/run.mjs [--teardown]   (see README.md)
import { writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launch, pickerWindow, waitShell, snap, jwt, log, rec, summary, files, keychainItem, UD, sleep, switchWorkspace } from "./common.mjs";
import { snapshot, adopt, teardown, leftovers, wsState, registryWorkspaces } from "./teardown.mjs";

const DO_TEARDOWN = process.argv.includes("--teardown");
const NAME1 = "e2e-one", NAME2 = "e2e-two";

async function createWorkspace(p, name) {
  await p.getByRole("button", { name: /Create new (workspace|sandbox)/ }).first().click();
  await p.locator('[data-testid="deps-continue"]').waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="deps-continue"]').disabled);
  await p.locator('[data-testid="deps-continue"]').click();
  await p.fill("#sandbox-name", name);
  await p.locator(".modal button.primary").click();
  return adopt(name);
}
const api = (s, path, init) => s.evaluate(async ([u, o]) => { const x = await fetch(u, o); const t = await x.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: x.status, body: b }; }, [path, init]);

// ---- Step 5: Keychain is touched once, only when a session is saved ----
// A leftover "safestorage-disabled" flag (written by any earlier launch whose Keychain call
// failed) permanently disables safeStorage, so the relaunch could never decrypt the session.
// This touches the app's real profile (UD defaults to the installed app's userData), so it is
// opt-in (AW_E2E_RESET_AUTH=1) and MOVES the files to a timestamped backup dir instead of deleting
// them. The app is launched with --user-data-dir=<UD>, so the harness and Electron always share one
// profile. Point AW_E2E_USER_DATA at a throwaway dir to avoid touching a real session at all.
// session.json is the legacy PLAINTEXT token: it is never copied into a backup. If one exists the
// run refuses to reset and asks for an isolated profile instead.
const AUTH_FILES = ["session.bin", "safestorage-disabled", "safestorage-attempt"];
if (process.env.AW_E2E_RESET_AUTH === "1") {
  if (existsSync(join(UD, "session.json"))) throw new Error(`${join(UD, "session.json")} holds a plaintext session token; refusing to back it up or delete it. Use an isolated AW_E2E_USER_DATA dir.`);
  const present = AUTH_FILES.filter((f) => existsSync(join(UD, f)));
  if (present.length) {
    const bak = join(UD, `e2e-auth-backup-${Date.now()}`);
    mkdirSync(bak, { recursive: true });
    for (const f of present) renameSync(join(UD, f), join(bak, f));
    log("auth state moved to", bak, present);
  }
} else if (AUTH_FILES.some((f) => existsSync(join(UD, f)))) {
  log("WARNING: existing auth files in", UD, "- a stale safestorage-disabled flag makes the step 5 relaunch fail; set AW_E2E_RESET_AUTH=1 to back them up and start clean");
}
snapshot();
log("keychain item before:", keychainItem(), "files:", files());
let app = await launch();
let page = await pickerWindow(app);
await page.waitForSelector('input[type="email"], input[type="password"]', { timeout: 20000 });
rec("s5: fresh launch shows login (no session)", true, "version " + (await app.evaluate(({ app }) => app.getVersion())));
rec("s5: launch without a session does not touch Keychain", keychainItem() === "absent" || files().length === 0, `keychain=${keychainItem()}`);
const enc = await app.evaluate(({ safeStorage }, j) => ({ avail: safeStorage.isEncryptionAvailable(), b64: safeStorage.encryptString(j).toString("base64") }), jwt());
rec("s5: safeStorage encrypts the session token", enc.avail && enc.b64.length > 0);
writeFileSync(join(UD, "session.bin"), Buffer.from(enc.b64, "base64"));
await app.close();
app = await launch();
page = await pickerWindow(app);
rec("s5: relaunch loads the saved session and reaches the picker", await page.waitForSelector('[data-testid="local-block"]', { timeout: 30000 }).then(() => true).catch(() => false));
await sleep(1500);
rec("s5: no storage warning with a working Keychain", !(await page.locator('[data-testid="storage-warning"]').isVisible().catch(() => false)));
await snap(page, "s5-picker");

// ---- Step 6: two real local workspaces ----
const w1 = await createWorkspace(page, NAME1);
const PORT1 = w1.uiPort;
const s1 = await waitShell(app, PORT1, 120);
await s1.waitForLoadState("load").catch(() => {});
await s1.waitForTimeout(3000);
rec("s6: workspace 1 shell served on its own port", s1.url().startsWith(`http://127.0.0.1:${PORT1}`), s1.url());
rec("s6: /api/health 200 through the front server", (await api(s1, "/api/health")).status === 200);
await snap(s1, "s6-shell1");

const cat = await api(s1, "/api/apps/-/catalog?refresh=true");
const n = Array.isArray(cat.body) ? cat.body.length : (cat.body?.apps?.length ?? 0);
rec("s6: marketplace catalog loads through the local workspace", cat.status === 200 && n > 0, `${n} apps`);
const hosts = await s1.evaluate(() => [...new Set(performance.getEntriesByType("resource").map((e) => new URL(e.name).host))]);
rec("s6: UI only talks to 127.0.0.1 (plus fonts)", hosts.every((h) => h.startsWith("127.0.0.1") || h === "fonts.googleapis.com" || h === "fonts.gstatic.com"), hosts.join(","));

const t = await api(s1, "/api/terminals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "e2e-pty" }) });
const tid = t.body?.id;
await api(s1, `/api/terminals/${tid}/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "echo PTY_OK_$((6*7))", send_enter: true }) });
await sleep(2500);
const sb = await api(s1, `/api/terminals/${tid}/scrollback`);
rec("s6: terminal PTY executes a command", String(sb.body?.content ?? "").includes("PTY_OK_42"));
await api(s1, `/api/terminals/${tid}`, { method: "DELETE" });

await switchWorkspace(app);
await sleep(2500);
page = await pickerWindow(app);
await page.bringToFront();
await page.waitForSelector('[data-testid="local-block"]', { timeout: 20000 });
rec("s6: picker after switch shows 1/2", (await page.locator('[data-testid="local-badge"]').innerText()) === "1/2");
const w2 = await createWorkspace(page, NAME2);
const s2 = await waitShell(app, w2.uiPort, 120);
await s2.waitForLoadState("load").catch(() => {});
rec("s6: workspace 2 healthy on its own port", (await api(s2, "/api/health")).status === 200);
await switchWorkspace(app);
await sleep(2500);
page = await pickerWindow(app);
await page.bringToFront();
await page.waitForSelector('[data-testid="local-block"]');
rec("s6: picker shows 2/2", (await page.locator('[data-testid="local-badge"]').innerText()) === "2/2");
await page.getByRole("button", { name: /Create new (workspace|sandbox)/ }).first().click();
await sleep(1500);
const dialogs = await page.locator(".modal").allInnerTexts();
rec("s6: third create is refused by the free-tier cap, wizard not shown", /free-tier limit/i.test(dialogs.join(" ")) && (await page.locator("#sandbox-name").count()) === 0);
await snap(page, "s6-cap-refused");
await page.getByText("Got it").click().catch(() => {});

// ---- Step 7: Remove button, for real (workspace 2 of 2) ----
const regBefore = registryWorkspaces();
const ws2 = regBefore.find((w) => w.name === NAME2);
const ws1 = regBefore.find((w) => w.name === NAME1);
rec("s7: registry has both workspaces before removal", regBefore.length === 2 && !!ws1 && !!ws2, regBefore.map((w) => `${w.name}:${w.id}:${w.uiPort}`).join(","));
const before = wsState(ws2.id, [ws2.uiPort, ws2.apiPort]);
rec("s7: workspace 2 resources exist before removal (machine, dirs, port)", before.machines.length === 1 && before.dirsLeft.length > 0 && before.listening.length > 0, JSON.stringify(before));
await page.locator(`[data-testid^="remove-"][aria-label="Remove ${NAME2}"]`).click();
await page.locator('[data-testid="remove-modal"]').waitFor({ timeout: 10000 });
await snap(page, "s7-remove-confirm");
await page.locator('[data-testid="remove-confirm"]').click();
await page.locator('[data-testid="remove-modal"]').waitFor({ state: "detached", timeout: 180000 }).catch(() => {});
await sleep(2500);
await snap(page, "s7-after-remove");
rec("s7: remove modal closed without an error", (await page.locator('[data-testid="remove-error"]').count()) === 0 && (await page.locator('[data-testid="remove-modal"]').count()) === 0);
rec("s7: picker counter went 2/2 -> 1/2", (await page.locator('[data-testid="local-badge"]').innerText()) === "1/2");
rec("s7: removed workspace no longer listed, the other still is", (await page.locator(`[data-testid="remove-${ws2.name}"]`).count()) === 0 && (await page.locator(`[aria-label="Remove ${NAME1}"]`).count()) === 1);
const after = wsState(ws2.id, [ws2.uiPort, ws2.apiPort]);
rec("s7: podman machine gone", after.machines.length === 0, after.machines.join(","));
rec("s7: containers and network gone", after.ctrs.length === 0 && after.nets.length === 0 && after.procs.length === 0, JSON.stringify({ ctrs: after.ctrs, nets: after.nets, procs: after.procs }));
rec("s7: home/data/tmp dirs gone", after.dirsLeft.length === 0, after.dirsLeft.join(","));
rec("s7: ports freed", after.listening.length === 0, after.listening.join(","));
rec("s7: registry entry gone", !after.inRegistry);
const keep = wsState(ws1.id, [ws1.uiPort]);
rec("s7: the other workspace untouched (machine and port still up)", keep.machines.length === 1 && keep.listening.length === 1, JSON.stringify({ m: keep.machines, l: keep.listening }));

// ---- Step 8: create again after removal ----
const NAME3 = "e2e-three";
const w3 = await createWorkspace(page, NAME3);
const ws3port = w3.uiPort;
const s3 = await waitShell(app, ws3port, 120);
await s3.waitForLoadState("load").catch(() => {});
rec("s8: re-created workspace healthy after a removal", (await api(s3, "/api/health")).status === 200, `port ${ws3port}`);
await snap(s3, "s8-shell3");
await switchWorkspace(app);
await sleep(2500);
page = await pickerWindow(app);
await page.bringToFront();
await page.waitForSelector('[data-testid="local-block"]');
rec("s8: picker shows 2/2 again", (await page.locator('[data-testid="local-badge"]').innerText()) === "2/2");
await snap(page, "s8-picker");

await app.close();
const ok = summary();

// ---- Teardown + leftovers ----
if (DO_TEARDOWN) await teardown();
const left = await leftovers();
for (const [k, v] of Object.entries(left)) rec(`leftovers: ${k}`, DO_TEARDOWN ? v.ok : true, v.detail);
const final = summary();
if (!DO_TEARDOWN) console.log("(leftovers reported only; re-run with --teardown to clean up and assert they are gone)");
process.exit(ok && final ? 0 : 1);
