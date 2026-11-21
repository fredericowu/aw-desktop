/** Pure helpers so the "never leave the picker stuck" behaviour is unit-testable
 * without Electron. */

export interface OpenError {
  slug: string;
  message: string;
}

export function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** Run a workspace open; on failure report it (so the UI can return to the
 * picker with a retry) instead of letting the rejection escape. */
export async function guardedOpen(slug: string, run: () => Promise<unknown>, onError: (e: OpenError) => void): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    onError({ slug, message: describeError(err) });
    return false;
  }
}

/** Persisting the session (Keychain/safeStorage) is best effort: a failure
 * keeps the session in memory for this run and returns a warning to show. */
export function persistSessionSafely(save: () => void): string | null {
  try {
    save();
    return null;
  } catch (err) {
    return `Could not save your session to the macOS Keychain (${describeError(err)}). You are signed in for this run only.`;
  }
}
