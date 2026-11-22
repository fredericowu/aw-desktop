import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PODMAN_PKG_SHA256, PODMAN_VERSION } from "../src/main/dependencies";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("bundled engine pin", () => {
  it("scripts/engine-ref carries the same version and sha256 as the app's pin", () => {
    const ref = read("scripts/engine-ref");
    expect(ref).toContain(`VERSION=${PODMAN_VERSION}\n`);
    expect(ref).toContain(`ARM64_SHA256=${PODMAN_PKG_SHA256["arm64"]}\n`);
  });

  it("gvproxy is pinned to the patched release, not the pkg's v0.8.9", () => {
    const ref = read("scripts/engine-ref");
    expect(ref).toMatch(/^GVPROXY_VERSION=v0\.(9|[1-9]\d)\.\d+$/m);
    expect(ref).toMatch(/^GVPROXY_SHA256=[0-9a-f]{64}$/m);
    expect(read("scripts/fetch-engine.sh")).toContain("gvproxy-darwin");
  });

  it("every engine binary is listed for signing and the plist grants what the VM helpers need", () => {
    const yml = read("electron-builder.yml");
    for (const b of ["bin/podman", "bin/gvproxy", "bin/vfkit", "bin/krunkit", "lib/libkrun.dylib", "lib/libvirglrenderer.1.dylib", "lib/libepoxy.0.dylib", "lib/libMoltenVK.dylib"]) {
      expect(yml).toContain(`Contents/Resources/engine/${b}`);
    }
    const plist = read("build/entitlements.mac.plist");
    for (const k of ["com.apple.security.virtualization", "com.apple.security.hypervisor", "com.apple.security.cs.disable-library-validation"]) {
      expect(plist).toMatch(new RegExp(`<key>${k}</key>\\s*<true/>`));
    }
  });

  it("the release workflow fetches the engine before building and verifies signing", () => {
    const wf = read(".github/workflows/release.yml");
    expect(wf.indexOf("scripts/fetch-engine.sh")).toBeGreaterThan(-1);
    expect(wf.indexOf("scripts/fetch-engine.sh")).toBeLessThan(wf.indexOf("electron-builder --mac"));
    expect(wf).toContain("build/verify-engine-signing.sh");
  });
});
