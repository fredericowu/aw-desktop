// Drives the REAL packaged AW Desktop.app (Playwright _electron) against mock-backend.mjs.
// Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 node run.mjs <AW Desktop.app> <workdir> <port>
// Never touches ~/.aw-remote-host: it only reads host status. Does NOT click "Create".
import { _electron as electron } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [appPath, work, port] = process.argv.slice(2);
const shots = join(work, "shots"); mkdirSync(shots, { recursive: true });
const results = [];
const rec = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail); };
const ctl = (b) => fetch(`https://127.0.0.1:${port}/__ctl`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
const logLines = () => readFileSync(join(work, "mock.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const app = await electron.launch({
  executablePath: join(appPath, "Contents/MacOS/AW Desktop"),
  args: [`--user-data-dir=${join(work, "userdata")}`, "--ignore-certificate-errors"],
  env: { ...process.env, AW_DESKTOP_APEX: `127.0.0.1.nip.io:${port}`, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
});
// A headless/ssh Mac session cannot answer the macOS Keychain prompt that safeStorage.encryptString
// raises on first save of the token; it blocks the main process forever. Stub it for the harness only.
// APEX carries a port in this harness; Chromium rejects a cookie Domain with a port, so session.cookies.set rejects (prod apex has no port).
await app.evaluate(({ session }) => { const c = session.defaultSession.cookies; c.set = async () => {}; c.remove = async () => {}; });
// Keychain FAILURE path (v0.1.8): encryptString throws -> sign-in must still complete (in memory) with a visible warning.
await app.evaluate(({ safeStorage }) => { safeStorage.encryptString = () => { throw new Error("keychain denied"); }; safeStorage.decryptString = (b) => b.toString(); safeStorage.isEncryptionAvailable = () => true; });
const restoreKeychain = () => app.evaluate(({ safeStorage }) => { safeStorage.encryptString = (s) => Buffer.from(s); });
const authPage = async () => { for (let i = 0; i < 50; i++) { const w = app.windows().find((x) => !x.url().includes(".workspace.")); if (w) return w; await new Promise((r) => setTimeout(r, 200)); } throw new Error("no auth window"); };
const snap = async (page, name) => {
  const p = join(shots, name + ".png"); await page.screenshot({ path: p }); console.log("SHOT", p);
  const txt = await page.evaluate(() => document.body.innerText).catch(() => "");
  writeFileSync(join(shots, name + ".txt"), txt); console.log("TEXT", name, JSON.stringify(txt.replace(/\s+/g, " ").slice(0, 300)));
};
const menu = (label) => app.evaluate(({ Menu }, l) => { const ws = Menu.getApplicationMenu().items.find((i) => i.label === "Workspace"); ws.submenu.items.find((i) => i.label.startsWith(l)).click(); return true; }, label);

let page = await authPage();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector('input[type="email"], input[type="password"]', { timeout: 15000 });
rec("launch: login screen shown", true, "version " + (await app.evaluate(({ app }) => app.getVersion())));
await snap(page, "01-login");

// wrong credentials -> error, stays on login
await page.fill('input[type="email"]', "e2e@example.invalid");
await page.fill('input[type="password"]', "wrong");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
await snap(page, "02-login-wrong-password");

// Google handoff: stub openExternal (do not open a real browser), then deliver awdesktop://auth?code=
await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
await page.getByRole("button", { name: /Google/ }).click();
await page.waitForTimeout(800);
const opened = await app.evaluate(() => globalThis.__opened);
rec("google: system browser asked to open start URL (client=mac)", opened.length === 1 && opened[0].includes("/api/identity/google/start?client=mac"), opened[0] ?? "none");
await snap(page, "03-google-waiting");
await app.evaluate(({ app }) => app.emit("open-url", { preventDefault() {} }, "awdesktop://auth?code=e2e-code"));
await page.waitForSelector('[data-testid="local-block"]', { timeout: 15000 }).catch(async (e) => { await snap(page, "03b-google-callback-failed"); throw e; });
rec("google: awdesktop://auth callback exchanged, landed on picker", true);
rec("keychain failure: sign-in completed with visible warning (no hang)", await page.locator('[data-testid="storage-warning"]').isVisible(), (await page.locator('[data-testid="storage-warning"]').innerText().catch(() => "")).slice(0, 140));
await snap(page, "03c-keychain-warning");
await restoreKeychain();

// landing
await snap(page, "04-landing-local-cloud");
rec("landing: Local block present", await page.locator('[data-testid="local-block"]').isVisible());
rec("landing: Cloud block present", await page.locator('[data-testid="cloud-block"]').isVisible());
const cloudBtn = page.locator('[data-testid="cloud-block"] button[aria-describedby="cloud-caption"]');
rec("cloud: create button disabled", await cloudBtn.first().isDisabled());
const cap = (await page.locator('[data-testid="cloud-caption"]').innerText()).trim();
rec("cloud: caption 'Feature is not available at this time'", /Feature is not available at this time/.test(cap), cap);
const before = logLines().filter((l) => l.m === "POST" && l.u.startsWith("/api/workspaces")).length;
await cloudBtn.first().click({ force: true, timeout: 2000 }).catch(() => {});
await page.waitForTimeout(800);
const after = logLines().filter((l) => l.m === "POST" && l.u.startsWith("/api/workspaces")).length;
rec("cloud: forced click makes no POST /api/workspaces", before === after, `${before}->${after}`);
await snap(page, "05-cloud-disabled");

// Dependencies screen. The live Mac is linked, so the harness stubs the MAIN-process IPC handlers
// (no shipped test hook): getLocalHost -> unlinked, depsList/depsInstall -> a scripted state machine.
// Nothing is installed and Create is never clicked.
await app.evaluate(({ ipcMain }) => {
  const st = { host: "missing", podman: "missing", progress: 0, installs: [] };
  globalThis.__deps = st;
  const plan = (id) => ({ source: "https://example.invalid/" + id, size: "1.0 MB", checksum: "sha256 e2e", dest: "~/e2e", needsAdmin: false });
  const item = (id, title, state, extra = {}) => ({ id, title, sub: "", required: id !== "machine", state, plan: state === "installed" || id === "machine" ? undefined : plan(id), ...extra });
  ipcMain.removeHandler("aw:getLocalHost"); ipcMain.handle("aw:getLocalHost", () => ({ binary: false, linked: false }));
  ipcMain.removeHandler("aw:depsList");
  ipcMain.handle("aw:depsList", () => ({ platform: "darwin", supported: true,
    items: [item("host", "aw-remote-host", st.host, st.host === "installing" ? { progress: st.progress } : {}), item("podman", "Podman", st.podman), item("machine", "Podman machine", "missing")],
    ready: st.host === "installed" && st.podman === "installed" }));
  ipcMain.removeHandler("aw:depsInstall");
  ipcMain.handle("aw:depsInstall", (_e, id, approved) => { st.installs.push([id, approved]); if (approved) { st[id] = "installing"; st.progress = 40; } return { ok: true }; });
});
await page.locator('[data-testid="local-block"]').getByRole("button", { name: /Create/ }).first().click();
await page.waitForSelector('[data-testid="deps"]', { timeout: 20000 });
await snap(page, "06-deps-missing");
const stateOf = (id) => page.locator(`[data-testid="dep-${id}"]`).getAttribute("data-state");
const cont = page.locator('[data-testid="deps-continue"]');
rec("deps: host + podman listed as missing, Continue disabled", (await stateOf("host")) === "missing" && (await stateOf("podman")) === "missing" && (await cont.isDisabled()));
const planTxt = await page.locator('[data-testid="dep-podman-plan"]').innerText();
rec("deps: plan shows URL, size, checksum before any install", /example\.invalid\/podman/.test(planTxt) && /1\.0 MB/.test(planTxt) && /sha256/.test(planTxt), planTxt.replace(/\s+/g, " "));
rec("deps: nothing installed without a click", (await app.evaluate(() => globalThis.__deps.installs.length)) === 0);
await page.locator('[data-testid="dep-host-install"]').click();
await page.waitForFunction(() => document.querySelector('[data-testid="dep-host"]')?.getAttribute("data-state") === "installing", null, { timeout: 8000 });
rec("deps: click -> installing with progress (approved=true sent)", JSON.stringify(await app.evaluate(() => globalThis.__deps.installs)) === JSON.stringify([["host", true]]) && /40%/.test(await page.locator('[data-testid="dep-host-state"]').innerText()));
await snap(page, "07-deps-installing");
await app.evaluate(() => { globalThis.__deps.host = "installed"; globalThis.__deps.podman = "installed"; });
await page.waitForFunction(() => document.querySelector('[data-testid="dep-host"]')?.getAttribute("data-state") === "installed", null, { timeout: 10000 });
rec("deps: flips to installed on its own (3s poll, no click)", true);
await page.waitForFunction(() => !document.querySelector('[data-testid="deps-continue"]').disabled, null, { timeout: 8000 });
rec("deps: Continue enabled only when all required are installed", true);
await snap(page, "08-deps-ready");
await cont.click();
rec("deps: Continue goes to the name step", (await page.locator("#sandbox-name").count()) === 1);
await snap(page, "09-name-step");
await page.getByRole("button", { name: /Cancel|Back|Close/ }).first().click().catch(() => {});

// Workspace-open FAILURE path (v0.1.8): cookie write rejects -> picker shows error + Retry, not stuck on "Opening your workspace...".
await page.waitForTimeout(500);
await app.evaluate(({ session }) => { session.defaultSession.cookies.set = async () => { throw new Error("e2e: cookie rejected"); }; });
await page.getByRole("button", { name: /mock-cloud/ }).first().click();
await page.waitForSelector('[data-testid="open-error"]', { timeout: 10000 }).catch(() => {});
const oe = page.locator('[data-testid="open-error"]');
rec("open failure: picker shows error + Retry (not stuck)", (await oe.count()) > 0 && (await page.locator('[data-testid="open-retry"]').isVisible()), (await oe.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 140));
await snap(page, "08a-open-failure");
rec("open failure: no shell window opened", !app.windows().some((x) => x.url().includes(".workspace.")));
await app.evaluate(({ session }) => { session.defaultSession.cookies.set = async () => {}; });
await page.locator('[data-testid="open-retry"]').click().catch(() => {});
await page.waitForTimeout(4000);
rec("open failure: Retry opens the workspace shell", app.windows().some((x) => x.url().includes(".workspace.")));
// Switch Workspace (Cmd+Shift+W menu item): back to the picker
const shell0 = app.windows().find((x) => x.url().includes(".workspace."));
if (shell0) await snap(shell0, "08b-shell-after-retry");
await menu("Switch Workspace");
await page.waitForTimeout(2000);
// Switch Workspace again: open the shell from a clean picker
await page.waitForTimeout(500);
await page.getByRole("button", { name: /mock-cloud/ }).first().click().catch((e) => console.log("row click failed", String(e).slice(0, 120)));
await page.waitForTimeout(4000);
const shell = app.windows().find((x) => x.url().includes(".workspace."));
if (shell) { await snap(shell, "08-shell-window"); rec("workspace opens in shell window", true, shell.url()); }
else rec("workspace opens in shell window", false, "no shell window; windows=" + app.windows().map((x) => x.url()).join(" | "));
await menu("Switch Workspace");
await page.waitForTimeout(2000);
rec("Switch Workspace: shell closed, picker shown", !app.windows().some((x) => x.url().includes(".workspace.")) && (await page.locator('[data-testid="local-block"]').isVisible()));
await snap(page, "09-after-switch-workspace");

// Log out with a HANGING server logout call
await ctl({ logoutHang: true });
const t0 = Date.now();
await menu("Log out");
await page.waitForSelector('input[type="password"]', { timeout: 10000 });
const dt = Date.now() - t0;
rec("Log out with hanging /logout returns to login", dt < 6000, dt + " ms");
await snap(page, "10-after-logout-hang");
await ctl({ logoutHang: false });

writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
await app.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
