import { describe, expect, it } from "vitest";
import { isLocal, isPlanLimitCode, isSetupPending, splitWorkspaces } from "../src/shared/workspaces";
import type { WorkspaceInfo } from "../src/shared/types";

const ws = (over: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  name: "x",
  placement_driver: "remote-host",
  is_hosted: false,
  status: "running",
  ...over,
});

describe("local/cloud split", () => {
  it("remote-host and not hosted is Local", () => {
    expect(isLocal(ws({}))).toBe(true);
  });

  it("a hosted workspace stays Cloud after its driver flips to remote-host", () => {
    expect(isLocal(ws({ is_hosted: true }))).toBe(false);
    expect(isLocal(ws({ placement_driver: "hosted", is_hosted: true }))).toBe(false);
  });

  it("other drivers are Cloud", () => {
    const { local, cloud } = splitWorkspaces([
      ws({ name: "a" }),
      ws({ name: "b", placement_driver: "docker" }),
      ws({ name: "c", placement_driver: "hosted", is_hosted: true }),
    ]);
    expect(local.map((w) => w.name)).toEqual(["a"]);
    expect(cloud.map((w) => w.name)).toEqual(["b", "c"]);
  });

  it("an unbootstrapped local row is setup pending, a running one is not", () => {
    expect(isSetupPending(ws({ status: "provisioning" }))).toBe(true);
    expect(isSetupPending(ws({ status: "running" }))).toBe(false);
    expect(isSetupPending(ws({ placement_driver: "hosted", is_hosted: true, status: "provisioning" }))).toBe(false);
  });

  it("both 402 codes are the cap modal", () => {
    expect(isPlanLimitCode("plan_limit_local_workspaces")).toBe(true);
    expect(isPlanLimitCode("plan_limit_workspaces")).toBe(true);
    expect(isPlanLimitCode("plan_limit_members")).toBe(false);
    expect(isPlanLimitCode(undefined)).toBe(false);
  });
});
