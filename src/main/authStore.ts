import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Raw aw_id_jwt, encrypted via Electron safeStorage (Keychain-backed on
 * macOS) under userData — never a plaintext token file, never
 * localStorage. Matches the Architect design, card
 * 4175bf3b-9510-8104-8c21-f5008b4d708b §2. */
function tokenPath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return join(dir, "session.bin");
}

export function loadToken(): string | null {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = readFileSync(path);
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-level encryption (Keychain) is unavailable — cannot persist a session.");
  }
  writeFileSync(tokenPath(), safeStorage.encryptString(token));
}

export function clearToken(): void {
  const path = tokenPath();
  if (existsSync(path)) unlinkSync(path);
}
