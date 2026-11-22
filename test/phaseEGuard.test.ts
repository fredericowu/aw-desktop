import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM harness module, no type declarations
import { hostIntegrityError, parseHostMachine, workspacePodmanEnv } from "../e2e/phaseE/guard.mjs";
import { podmanEnv } from "../src/main/localRuntime";

describe("phaseE harness environment", () => {
  it("passes podman exactly the four variables the app uses, nothing inherited", () => {
    process.env.XDG_CONFIG_HOME = "/home/real/.config";
    process.env.CONTAINER_HOST = "unix:///real.sock";
    const env = workspacePodmanEnv("/h/podman-dist/podman/bin/podman", "/h/.awd", "local1", "/tmp", "arm64");
    expect(Object.keys(env).sort()).toEqual(["CONTAINERS_MACHINE_PROVIDER", "HOME", "PATH", "TMPDIR"]);
    expect(env.HOME).toBe("/h/.awd/local1/home");
    expect(env.TMPDIR).toBe("/tmp/aw-local1");
    expect(env.CONTAINERS_MACHINE_PROVIDER).toBe("libkrun");
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CONTAINER_HOST;
  });
  it("uses the same variable names as the app's own podmanEnv", () => {
    const app = podmanEnv({ path: "/p", arch: "arm64", homesRoot: "/h/.awd", dataRoot: "/h/data", tmpRoot: "/tmp" } as never, "local1");
    const harness = workspacePodmanEnv("/p/podman", "/h/.awd", "local1", "/tmp", "arm64");
    expect(Object.keys(harness).sort()).toEqual(Object.keys(app).sort());
  });
});

describe("phaseE host integrity", () => {
  it("parses the host machine state", () => {
    expect(parseHostMachine("podman-machine-default*\ttrue\n")).toBe("running");
    expect(parseHostMachine("podman-machine-default\tfalse\n")).toBe("stopped");
    expect(parseHostMachine("aw-local1\ttrue\n")).toBe("absent");
  });
  it("fails when the host VM was running before and stopped after", () => {
    const msg = hostIntegrityError({ machine: "running", health: "200" }, { machine: "stopped", health: "200" });
    expect(msg).toMatch(/podman-machine-default running -> stopped/);
  });
  it("fails when :9030 health changes", () => {
    expect(hostIntegrityError({ machine: "stopped", health: "200" }, { machine: "stopped", health: "down" })).toMatch(/:9030 health 200 -> down/);
  });
  it("fails when the host machine state could not be read, even if both captures match", () => {
    expect(hostIntegrityError({ machine: "unknown", health: "200" }, { machine: "unknown", health: "200" })).toMatch(/could not verify/);
  });
  it("passes on identical state, including a host VM stopped throughout", () => {
    expect(hostIntegrityError({ machine: "stopped", health: "down" }, { machine: "stopped", health: "down" })).toBeNull();
  });
});
