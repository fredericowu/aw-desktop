/** Pure helpers for the custom-scheme sign-in callback (no electron import, so they are unit-testable). */

export function extractCode(url: string): string | null {
  try {
    return new URL(url).searchParams.get("code");
  } catch {
    return null;
  }
}

/** The `awdesktop://...` URL in a second instance's argv (Windows/Linux), or null. */
export function findProtocolUrl(argv: readonly string[], scheme: string): string | null {
  const prefix = `${scheme}://`.toLowerCase();
  // Windows can wrap the argument in quotes depending on how the shell handed it over.
  for (const a of argv) {
    const t = a.replace(/^"+|"+$/g, "");
    if (t.toLowerCase().startsWith(prefix)) return t;
  }
  return null;
}
