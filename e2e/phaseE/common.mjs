// Shared helpers for the Phase E driver. Everything environment-specific comes from env vars.
import { _electron as electron } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const APP = process.env.AW_E2E_APP ?? "/Applications/AW Desktop.app";
export const EXE = join(APP, "Contents/MacOS/AW Desktop");
export const UD = process.env.AW_E2E_USER_DATA ?? join(HOME, "Library/Application Support/aw-desktop");
export const SHOTS = process.env.AW_E2E_SHOTS ?? join(process.cwd(), ".tmp/phaseE-shots");
mkdirSync(SHOTS, { recursive: true });

/** Test-account JWT: read from the file named by AW_E2E_JWT_FILE. Never logged, never committed. */
export function jwt() {
  const f = process.env.AW_E2E_JWT_FILE;
  if (!f) throw new Error("AW_E2E_JWT_FILE is required (path to a file holding the test account JWT)");
  return readFileSync(f, "utf8").trim();
}
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const results = [];
export const rec = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail); };
export const summary = () => { const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); return bad.length === 0; };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const files = () => (existsSync(UD) ? readdirSync(UD).filter((f) => /session|safestorage|identity|local/i.test(f)) : []);
export const keychainItem = () => { try { execFileSync("security", ["find-generic-password", "-s", "AW Desktop Safe Storage"], { stdio: "pipe" }); return "present"; } catch { return "absent"; } };

export const launch = (extraEnv = {}) => electron.launch({ executablePath: EXE, args: [`--user-data-dir=${UD}`], env: { ...process.env, ...extraEnv } });
export async function pickerWindow(app) {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((x) => !x.url().startsWith("http://127.0.0.1"));
    if (w) return w;
    await sleep(300);
  }
  throw new Error("no picker/auth window");
}
export const shellWindow = (app, port) => app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${port ?? ""}`));
export async function waitShell(app, port, tries = 40) {
  for (let i = 0; i < tries; i++) { const s = shellWindow(app, port); if (s) return s; await sleep(3000); }
  throw new Error(`no shell window on :${port}`);
}
export async function snap(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const t = await page.evaluate(() => document.body.innerText).catch(() => "");
  writeFileSync(join(SHOTS, `${name}.txt`), t);
  log("SHOT", name, JSON.stringify(t.replace(/\s+/g, " ").slice(0, 160)));
}
export const switchWorkspace = (app) =>
  app.evaluate(({ Menu }) => { const ws = Menu.getApplicationMenu().items.find((i) => i.label === "Workspace"); ws.submenu.items.find((i) => i.label.startsWith("Switch")).click(); });
