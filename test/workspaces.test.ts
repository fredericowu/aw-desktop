import { describe, expect, it } from "vitest";
import { isLocal, isPlanLimitCode, splitWorkspaces, LOCAL_PLACEMENT } from "../src/shared/workspaces";
import type { WorkspaceInfo } from "../src/shared/types";

const ws = (over: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  name: "x",
  placement_driver: LOCAL_PLACEMENT,
  is_hosted: false,
  status: "running",
  ...over,
});

describe("local/cloud split", () => {
  it("only the desktop-local placement is Local", () => {
    expect(isLocal(ws({}))).toBe(true);
    expect(isLocal(ws({ placement_driver: "remote-host" }))).toBe(false);
    expect(isLocal(ws({ placement_driver: "hosted", is_hosted: true }))).toBe(false);
  });

  it("splits registry rows from backend rows (old BYOD rows are cloud-side)", () => {
    const { local, cloud } = splitWorkspaces([
      ws({ name: "a" }),
      ws({ name: "b", placement_driver: "docker" }),
      ws({ name: "c", placement_driver: "remote-host" }),
    ]);
    expect(local.map((w) => w.name)).toEqual(["a"]);
    expect(cloud.map((w) => w.name)).toEqual(["b", "c"]);
  });

  it("both 402 codes are the cap modal", () => {
    expect(isPlanLimitCode("plan_limit_local_workspaces")).toBe(true);
    expect(isPlanLimitCode("plan_limit_workspaces")).toBe(true);
    expect(isPlanLimitCode("plan_limit_members")).toBe(false);
    expect(isPlanLimitCode(undefined)).toBe(false);
  });
});
