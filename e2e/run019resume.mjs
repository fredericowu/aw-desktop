// REAL packaged app, temp HOME: interrupted install (app killed mid-download) + resume after restart.
// Usage: HOME=<tmp> NODE_TLS_REJECT_UNAUTHORIZED=0 node run019resume.mjs <app> <work> <port>
import { _electron as electron } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [appPath, work, port] = process.argv.slice(2);
const shots = join(work, "shots"); mkdirSync(shots, { recursive: true });
const H = process.env.HOME; const ud = join(work, "userdata");
const results = [];
const rec = (n, ok, d = "") => { results.push({ name: n, ok, detail: d }); console.log(ok ? "PASS" : "FAIL", n, d); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 500)); } return false; };
import { rmSync } from "node:fs";
async function launch() {
  rmSync(join(ud, "session.bin"), { force: true }); // stored token would trigger a real Keychain prompt at startup (headless ssh cannot answer)
  const app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/AW Desktop"),
    args: [`--user-data-dir=${ud}`, "--ignore-certificate-errors"],
    env: { ...process.env, AW_DESKTOP_APEX: `127.0.0.1.nip.io:${port}`, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
  await app.evaluate(({ session, safeStorage }) => { const c = session.defaultSession.cookies; c.set = async () => {}; c.remove = async () => {};
    safeStorage.encryptString = (s) => Buffer.from(s); safeStorage.decryptString = (b) => b.toString(); safeStorage.isEncryptionAvailable = () => true; });
  let page; await until(async () => { page = app.windows().find((x) => !x.url().includes(".workspace.")); return !!page; }, 10000);
  await page.waitForLoadState("domcontentloaded");
  return { app, page, pid: app.process().pid };
}
async function toDeps(app, page) {
  await page.waitForSelector('input[type="email"], [data-testid="local-block"]', { timeout: 15000 });
  if (!(await page.locator('[data-testid="local-block"]').isVisible())) {
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    await page.getByRole("button", { name: /Google/ }).click(); await page.waitForTimeout(600);
    await app.evaluate(({ app }) => app.emit("open-url", { preventDefault() {} }, "awdesktop://auth?code=e2e-code"));
    await page.waitForSelector('[data-testid="local-block"]', { timeout: 15000 });
  }
  await page.locator('[data-testid="local-block"]').getByRole("button", { name: /Create/ }).first().click();
  await page.waitForSelector('[data-testid="deps"]', { timeout: 30000 });
}
const snap = async (page, n) => { await page.screenshot({ path: join(shots, n + ".png") }); writeFileSync(join(shots, n + ".txt"), await page.evaluate(() => document.body.innerText).catch(() => "")); };
const marker = () => { try { return JSON.parse(readFileSync(join(ud, "deps-install.json"), "utf8")); } catch { return null; } };

// ---- run 1: start podman install, SIGKILL mid-download
let { app, page, pid } = await launch(); await toDeps(app, page);
const st = (p, id) => p.locator(`[data-testid="dep-${id}"]`).getAttribute("data-state");
rec("r1: podman + host missing on fresh HOME, Continue disabled", (await st(page, "podman")) === "missing" && (await page.locator('[data-testid="deps-continue"]').isDisabled()), H);
await page.locator('[data-testid="dep-host-install"]').click();
rec("r1: host installs", await until(async () => (await st(page, "host")) === "installed", 120000));
await page.locator('[data-testid="dep-podman-install"]').click();
const mid = await until(async () => { const t = await page.locator('[data-testid="dep-podman-state"]').innerText(); const m = t.match(/(\d+)%/); return !!m && +m[1] >= 10 && +m[1] < 90; }, 60000);
rec("r1: podman reached mid-download (10-90%)", mid, (await page.locator('[data-testid="dep-podman-state"]').innerText()).replace(/\s+/g, " "));
await snap(page, "q1-mid-install");
rec("r1: interrupted marker persisted while installing", marker()?.installing === "podman", JSON.stringify(marker()));
process.kill(pid, "SIGKILL"); // only the PID this script launched
await new Promise((r) => setTimeout(r, 2000));
rec("r1: after SIGKILL no podman binary left (nothing partial kept)", !existsSync(join(H, "podman-dist/podman/bin/podman")));
rec("r1: marker survives the kill", marker()?.installing === "podman", JSON.stringify(marker()));

// ---- run 2: restart -> interrupted notice, host still installed, podman missing, Continue disabled, then resume
({ app, page } = await launch()); await toDeps(app, page);
await page.waitForSelector('[data-testid="deps-interrupted"]', { timeout: 10000 }).catch(() => {});
rec("r2: interrupted notice shown after restart", await page.locator('[data-testid="deps-interrupted"]').isVisible(), (await page.locator('[data-testid="deps-interrupted"]').innerText().catch(() => "")).slice(0, 120));
rec("r2: host still installed (state persists), podman missing, Continue disabled", (await st(page, "host")) === "installed" && (await st(page, "podman")) === "missing" && (await page.locator('[data-testid="deps-continue"]').isDisabled()));
await snap(page, "q2-interrupted-after-restart");
rec("r2: nothing auto-resumed without a click", (await st(page, "podman")) === "missing");
await page.locator('[data-testid="dep-podman-install"]').click();
rec("r2: user re-approves, podman installs to completion", await until(async () => (await st(page, "podman")) === "installed", 420000), await st(page, "podman"));
rec("r2: Continue enabled, interrupted notice cleared", await until(async () => !(await page.locator('[data-testid="deps-continue"]').isDisabled()) && !(await page.locator('[data-testid="deps-interrupted"]').isVisible()), 15000));
await snap(page, "q3-resumed-ready");
rec("r2: marker cleared after success", marker()?.installing == null, JSON.stringify(marker()));
// ---- run 3: restart again -> straight to ready
await app.close(); ({ app, page } = await launch()); await toDeps(app, page);
rec("r3: second restart shows both installed, Continue enabled, no interrupted notice", (await until(async () => (await st(page, "podman")) === "installed", 8000)) && !(await page.locator('[data-testid="deps-continue"]').isDisabled()) && !(await page.locator('[data-testid="deps-interrupted"]').isVisible()));
await snap(page, "q4-restart-ready");
writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
await app.close(); process.exit(results.every((r) => r.ok) ? 0 : 1);
