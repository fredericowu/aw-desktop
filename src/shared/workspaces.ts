import type { WorkspaceInfo } from "./types";

/** Placement of a workspace that lives in aw-desktop's own registry: standalone, on this Mac,
 * no row in aw-backend. Everything else (including old BYOD remote-host rows) is listed as cloud-side. */
export const LOCAL_PLACEMENT = "desktop-local";

export function isLocal(ws: Pick<WorkspaceInfo, "placement_driver">): boolean {
  return ws.placement_driver === LOCAL_PLACEMENT;
}

export function splitWorkspaces(list: WorkspaceInfo[]): { local: WorkspaceInfo[]; cloud: WorkspaceInfo[] } {
  const local: WorkspaceInfo[] = [];
  const cloud: WorkspaceInfo[] = [];
  for (const ws of list) (isLocal(ws) ? local : cloud).push(ws);
  return { local, cloud };
}

/** Both 402 codes mean "you are at a cap": the old backend (before
 * max_local_workspaces is deployed) answers a local create with
 * plan_limit_workspaces. */
export function isPlanLimitCode(code: string | undefined | null): boolean {
  return code === "plan_limit_local_workspaces" || code === "plan_limit_workspaces";
}

export const DEFAULT_LOCAL_LIMIT = 2;
