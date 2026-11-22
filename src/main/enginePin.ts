/** Pinned bundled engine. Must match scripts/engine-ref (pinned by test/engineBundle.test.ts).
 * Only an arm64 build exists for this release, so Intel Macs are unsupported. */
export const PODMAN_VERSION = "6.0.2";
export const PODMAN_PKG_SHA256: Record<string, string> = {
  arm64: "5a1d97f98f626cdb82dbd9932cf43102d1e9b6621627085fec2dcadf59743930",
};
