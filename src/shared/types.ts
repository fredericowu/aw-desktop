export interface AwUser {
  id: number;
  email: string;
  is_active: boolean;
  memberships: Membership[];
  platform_role: string | null;
  is_aw_owner: boolean;
  glasses_workspace: string | null;
}

export interface Membership {
  workspace: string;
  role: string;
}

/** A row of GET /api/workspaces (subset of aw-backend's _serialize). */
export interface WorkspaceInfo {
  name: string;
  placement_driver: string;
  is_hosted: boolean;
  status: string;
}

/** GET /api/accounts/me — limits + local_count are added by aw-backend's
 * max_local_workspaces change; absent on an older backend. */
export interface AccountInfo {
  limits?: { max_workspaces?: number; max_local_workspaces?: number };
  local_count?: number;
}

export type RuntimeKind = "podman" | "docker-desktop" | "colima";

export interface RuntimeStatus {
  kind: RuntimeKind;
  installed: boolean;
  running: boolean;
  path?: string;
}

export interface RuntimeCheck {
  runtimes: RuntimeStatus[];
  /** At least one runtime is installed AND running. */
  ready: boolean;
}

/** Result of a call that can fail with a backend error: `code` is the
 * backend's `error` field (e.g. plan_limit_local_workspaces), `status` the
 * HTTP status. */
export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  status?: number;
  limit?: number;
}

export interface WorkspaceListData {
  workspaces: WorkspaceInfo[];
  account: AccountInfo | null;
}

export type AuthStage =
  | "splash"
  | "login"
  | "signup"
  | "forgot-password"
  | "picker"
  | "loading-workspace"
  | "error";

export interface AuthState {
  stage: AuthStage;
  user: AwUser | null;
  error: string | null;
  apex: string;
}

export interface SessionResult {
  ok: boolean;
  user?: AwUser;
  error?: string;
}

/** Renderer-facing bridge exposed on `window.aw` by the preload script.
 * Every call is forwarded to the main process over ipcRenderer.invoke —
 * the renderer never talks to aw-backend directly (see SKILL note on the
 * SameSite cookie gotcha: a renderer-origin fetch silently drops it). */
export interface AwBridge {
  getState(): Promise<AuthState>;
  login(email: string, password: string): Promise<SessionResult>;
  signup(email: string, password: string): Promise<SessionResult>;
  startEmailCode(email: string): Promise<{ ok: boolean; error?: string }>;
  verifyEmailCode(email: string, code: string): Promise<SessionResult>;
  startGoogleSignIn(): Promise<{ ok: boolean; error?: string }>;
  pickWorkspace(slug: string): Promise<{ ok: boolean; error?: string }>;
  listWorkspaces(): Promise<ApiResult<WorkspaceListData>>;
  checkRuntime(): Promise<RuntimeCheck>;
  createLocalWorkspace(name: string): Promise<ApiResult<WorkspaceInfo>>;
  logout(): Promise<void>;
  onStateChanged(cb: (state: AuthState) => void): () => void;
}
