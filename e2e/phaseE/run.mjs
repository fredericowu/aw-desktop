// Phase E e2e: drives the REAL installed AW Desktop.app (Playwright _electron) through the
// standalone local-workspace path against real podman. Needs a logged-in macOS GUI session.
// Usage: AW_E2E_JWT_FILE=<file> node e2e/phaseE/run.mjs [--teardown]   (see README.md)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, pickerWindow, waitShell, snap, jwt, log, rec, summary, files, keychainItem, UD, sleep, switchWorkspace } from "./common.mjs";
import { teardown, leftovers } from "./teardown.mjs";

const DO_TEARDOWN = process.argv.includes("--teardown");
const PORT1 = 9031, PORT2 = 9033;
const NAME1 = "e2e-one", NAME2 = "e2e-two";

async function createWorkspace(p, name) {
  await p.getByRole("button", { name: /Create new sandbox/ }).first().click();
  await p.locator('[data-testid="deps-continue"]').waitFor();
  await p.waitForFunction(() => !document.querySelector('[data-testid="deps-continue"]').disabled);
  await p.locator('[data-testid="deps-continue"]').click();
  await p.fill("#sandbox-name", name);
  await p.locator(".modal button.primary").click();
}
const api = (s, path, init) => s.evaluate(async ([u, o]) => { const x = await fetch(u, o); const t = await x.text(); let b; try { b = JSON.parse(t); } catch { b = t; } return { status: x.status, body: b }; }, [path, init]);

// ---- Step 5: Keychain is touched once, only when a session is saved ----
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
await createWorkspace(page, NAME1);
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
await createWorkspace(page, NAME2);
const s2 = await waitShell(app, PORT2, 120);
await s2.waitForLoadState("load").catch(() => {});
rec("s6: workspace 2 healthy on its own port", (await api(s2, "/api/health")).status === 200);
await switchWorkspace(app);
await sleep(2500);
page = await pickerWindow(app);
await page.bringToFront();
await page.waitForSelector('[data-testid="local-block"]');
rec("s6: picker shows 2/2", (await page.locator('[data-testid="local-badge"]').innerText()) === "2/2");
await page.getByRole("button", { name: /Create new sandbox/ }).first().click();
await sleep(1500);
const dialogs = await page.locator(".modal").allInnerTexts();
rec("s6: third create is refused by the free-tier cap, wizard not shown", /free-tier limit/i.test(dialogs.join(" ")) && (await page.locator("#sandbox-name").count()) === 0);
await snap(page, "s6-cap-refused");
await page.getByText("Got it").click().catch(() => {});

await app.close();
const ok = summary();

// ---- Teardown + leftovers ----
if (DO_TEARDOWN) await teardown();
const left = await leftovers();
for (const [k, v] of Object.entries(left)) rec(`leftovers: ${k}`, DO_TEARDOWN ? v.ok : true, v.detail);
const final = summary();
if (!DO_TEARDOWN) console.log("(leftovers reported only; re-run with --teardown to clean up and assert they are gone)");
process.exit(ok && final ? 0 : 1);
