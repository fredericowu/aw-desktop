import { describe, expect, it } from "vitest";
import { classifyError, looksLikeEngineText } from "../src/main/errorClassifier";
import { PodmanCommandError } from "../src/main/localRuntime";

const podmanErr = (stderr: string) =>
  new PodmanCommandError(["machine", "start", "aw-local1"], { code: 125, stdout: "", stderr });

describe("classifyError", () => {
  it.each([
    ["no space", "Error: write /var/lib: no space left on device", "low_disk"],
    ["ENOSPC", "ENOSPC: no space", "low_disk"],
    ["oom", "cannot allocate memory", "low_memory"],
    ["hypervisor", "vfkit: hypervisor not supported on this host", "virtualization_unavailable"],
    ["pull dns", "Error: pulling image: dial tcp: lookup ghcr.io: no such host", "download_failed"],
    ["pull timeout", "Get \"https://ghcr.io/v2/\": net/http: TLS handshake timeout", "download_failed"],
    ["unknown", "something nobody has ever seen", "start_failed"],
    ["empty", "", "start_failed"],
  ])("%s -> %s", (_n, stderr, code) => {
    expect(classifyError(podmanErr(stderr)).code).toBe(code);
  });

  it("classifies plain strings and non-Error values", () => {
    expect(classifyError("no space left on device").code).toBe("low_disk");
    expect(classifyError(undefined).code).toBe("start_failed");
    expect(classifyError({ weird: true }).code).toBe("start_failed");
  });

  it("unknown text never maps to a specific wrong message", () => {
    expect(classifyError(new Error("exit status 1")).code).toBe("start_failed");
  });

  it("the user message never contains the raw stderr or engine wording", () => {
    const c = classifyError(podmanErr("podman machine start failed: gvproxy exited, /Users/x/.awd/local1/home/.podman/a.sock"));
    expect(c.raw).toContain("gvproxy");
    expect(c.message).not.toMatch(/podman|gvproxy|\.sock|machine|exit/i);
    expect(c.message).toBe("The workspace couldn't start. Retry, or copy details for support.");
  });

  it("looksLikeEngineText flags engine output only", () => {
    expect(looksLikeEngineText("podman machine init failed (exit 125)")).toBe(true);
    expect(looksLikeEngineText("fetch failed")).toBe(false);
  });
});
