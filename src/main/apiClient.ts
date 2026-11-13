import { API_BASE } from "./config";
import type { AwUser } from "../shared/types";

export interface TokenResponse {
  token: string;
  user: AwUser;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status));
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

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status));
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
