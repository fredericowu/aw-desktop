import { API_BASE } from "./config";
import type { AccountInfo, AwUser, WorkspaceInfo } from "../shared/types";

export interface TokenResponse {
  token: string;
  user: AwUser;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The backend's machine-readable `error` field, when present. */
    public code?: string,
    /** The backend's `limit` field on plan-limit 402s. */
    public limit?: number,
  ) {
    super(message);
  }
}

function errorCode(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const e = (data as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return undefined;
}

function errorLimit(data: unknown): number | undefined {
  if (data && typeof data === "object") {
    const l = (data as Record<string, unknown>).limit;
    if (typeof l === "number") return l;
  }
  return undefined;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data, res.status), errorCode(data), errorLimit(data));
  }
  return data as T;
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const detail = record.message ?? record.error;
    if (typeof detail === "string") return detail;
  }
  return `Request failed with status ${status}`;
}

async function get<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data, res.status), errorCode(data), errorLimit(data));
  }
  return data as T;
}

export function login(email: string, password: string): Promise<TokenResponse> {
  return post<TokenResponse>("/api/identity/login", { email, password });
}

export function signup(email: string, password: string): Promise<TokenResponse> {
  return post<TokenResponse>("/api/signup", { email, password });
}

export function startEmailCode(email: string): Promise<{ ok: boolean }> {
  return post("/api/identity/email-code/start", { email });
}

export function verifyEmailCode(email: string, code: string): Promise<TokenResponse> {
  return post<TokenResponse>("/api/identity/email-code/verify", { email, code });
}

/** POST /api/identity/google/exchange {code} -> {token, user} — redeems the
 * one-time code handed back on the awdesktop://auth custom scheme (see
 * native_oauth_handoff.py). */
export function exchangeGoogleCode(code: string): Promise<TokenResponse> {
  return post<TokenResponse>("/api/identity/google/exchange", { code });
}

export function me(token: string): Promise<AwUser> {
  return get<AwUser>("/api/identity/me", token);
}

/** GET /api/workspaces — membership-filtered, with placement_driver / is_hosted
 * / status per row (aw-backend _serialize). */
export async function listWorkspaces(token: string): Promise<WorkspaceInfo[]> {
  const data = await get<{ workspaces: WorkspaceInfo[] }>("/api/workspaces", token);
  return data.workspaces ?? [];
}

/** GET /api/accounts/me — plan limits + local_count. */
export function accountMe(token: string): Promise<AccountInfo> {
  return get<AccountInfo>("/api/accounts/me", token);
}

/** POST /api/workspaces with the BYOD placement. Creates a REAL provisioning
 * row (consumes the local cap); nothing is brought up until Phase 2. */
export function createWorkspace(token: string, name: string): Promise<WorkspaceInfo> {
  return post<WorkspaceInfo>("/api/workspaces", { name, placement_driver: "remote-host" }, token);
}

/** POST /api/workspaces/{slug}/bootstrap-token -> one-time awbs_ token. The
 * caller must never log or persist it. */
export function mintBootstrapToken(token: string, slug: string): Promise<{ token: string; expires_at: number }> {
  return post(`/api/workspaces/${encodeURIComponent(slug)}/bootstrap-token`, {}, token);
}

/** GET /api/workspaces/{slug} — detail row; `status` flips to running once linked + up. */
export function getWorkspace(token: string, slug: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
  return get<WorkspaceInfo>(`/api/workspaces/${encodeURIComponent(slug)}`, token, signal);
}

export async function refresh(token: string): Promise<TokenResponse> {
  const res = await fetch(`${API_BASE}/api/identity/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(res.status, "refresh_failed");
  return (await res.json()) as TokenResponse;
}

export async function logout(token: string): Promise<void> {
  await fetch(`${API_BASE}/api/identity/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}

export { ApiError };
