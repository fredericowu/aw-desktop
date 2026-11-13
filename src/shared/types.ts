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
  createWorkspace(): Promise<{ ok: boolean; error?: string }>;
  logout(): Promise<void>;
  onStateChanged(cb: (state: AuthState) => void): () => void;
}
