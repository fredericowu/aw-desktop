/** Pinned bundled engine. Must match scripts/engine-ref (pinned by test/engineBundle.test.ts).
 * Only an arm64 build exists for this release, so Intel Macs are unsupported. */
export const PODMAN_VERSION = "6.0.2";
export const PODMAN_PKG_SHA256: Record<string, string> = {
  arm64: "5a1d97f98f626cdb82dbd9932cf43102d1e9b6621627085fec2dcadf59743930",
};
/** Windows engine zip (podman.exe, win-sshproxy.exe) and the patched gvproxy-windows.exe. Same pin file. */
export const PODMAN_WINDOWS_ZIP_SHA256: Record<string, string> = {
  x64: "2c055d363de03de917f79568a78b7d5902fc40453bbcc141ca18cf0a1fa1b78e",
};
export const GVPROXY_WINDOWS_SHA256 = "41c660f7a9d54018e3b372b8f6aa4d124070bb4b5104d829f8da2171f91a9d22";
