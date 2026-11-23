// Phase E, no-default-Keychain launch/relaunch checks. Needs a logged-in macOS GUI session and the
// installed app, but NO credentials and no podman: it never signs in and never creates a workspace.
//
// With no default Keychain, safeStorage raises a modal dialog on every call, so the app (see
// src/main/authStoreCore.ts) touches it at most once per run and records the failure in the profile:
//   safestorage-disabled  = a Keychain call failed; never call safeStorage again
//   safestorage-attempt   = a call started and never returned (hang/kill); treat as failed next launch
// This script seeds exactly those states into a THROWAWAY profile (never the real one) next to a
// dummy session.bin, then launches the real app twice and asserts it reaches the login screen
// without decrypting the session, and leaves the profile in the disabled state.
// Usage: node e2e/phaseE/nokeychain.mjs   (see README.md)
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// UD in common.mjs is read at import time, so the throwaway profile must be set first.
const profile = mkdtempSync(join(tmpdir(), "aw-e2e-nokc-"));
process.env.AW_E2E_USER_DATA = profile;
const { launch, pickerWindow, snap, log, rec, summary, keychainItem } = await import("./common.mjs");

const LOGIN = 'input[type="email"], input[type="password"]';
const flag = join(profile, "safestorage-disabled");
const attempt = join(profile, "safestorage-attempt");
const session = join(profile, "session.bin");

async function launchExpectLogin(label) {
  const kcBefore = keychainItem();
  const app = await launch();
  try {
    const page = await pickerWindow(app);
    const login = await page.waitForSelector(LOGIN, { timeout: 20000 }).then(() => true).catch(() => false);
    rec(`nokc ${label}: reaches the login screen (no hang, session not loaded)`, login);
    rec(`nokc ${label}: no local-workspace picker (the saved session was not decrypted)`, (await page.locator('[data-testid="local-block"]').count()) === 0);
    rec(`nokc ${label}: Keychain item state unchanged`, keychainItem() === kcBefore, `${kcBefore} -> ${keychainItem()}`);
    await snap(page, `nokc-${label}`);
  } finally { await app.close().catch(() => {}); }
}

try {
  // A: a previous run's Keychain call failed (disabled flag) and left a session blob behind.
  writeFileSync(session, Buffer.from("not-a-real-encrypted-session"));
  writeFileSync(flag, String(Date.now()));
  await launchExpectLogin("flag-launch");
  rec("nokc flag-launch: disabled flag persists", existsSync(flag));
  rec("nokc flag-launch: no attempt marker left behind", !existsSync(attempt));
  await launchExpectLogin("flag-relaunch");
  rec("nokc flag-relaunch: disabled flag still persists", existsSync(flag));
  rec("nokc flag-relaunch: no attempt marker left behind", !existsSync(attempt));

  // B: the last Keychain call never returned (attempt marker only): next launch must disable it.
  rmSync(flag, { force: true });
  writeFileSync(attempt, String(Date.now()));
  await launchExpectLogin("hung-attempt-launch");
  rec("nokc hung-attempt: converted into the disabled flag", existsSync(flag));
  rec("nokc hung-attempt: attempt marker cleared", !existsSync(attempt));
} catch (e) {
  rec("nokc: run completed without a thrown error", false, String(e?.message ?? e));
} finally {
  rmSync(profile, { recursive: true, force: true });
  log("throwaway profile removed", profile);
}
process.exit(summary() ? 0 : 1);
