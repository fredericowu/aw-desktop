import type { WorkspaceInfo } from "./types";

/** Local = a BYOD workspace (remote-host placement) that WE do not host.
 * A hosted workspace's placement_driver also flips to "remote-host" once its
 * outer host links, so `is_hosted` is the discriminator (aw-backend
 * is_hosted_workspace), never the driver alone. Everything else is Cloud. */
export function isLocal(ws: Pick<WorkspaceInfo, "placement_driver" | "is_hosted">): boolean {
  return ws.placement_driver === "remote-host" && !ws.is_hosted;
}

/** A local workspace whose row exists but nothing has brought it up on this
 * Mac yet. Phase 1 creates rows without bootstrapping, so these are shown as
 * "Setup pending on this Mac" and are not openable. */
export function isSetupPending(ws: WorkspaceInfo): boolean {
  return isLocal(ws) && ws.status !== "running";
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
