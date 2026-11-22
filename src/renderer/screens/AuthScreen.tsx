import { useState, FormEvent } from "react";
import type { AuthState } from "../../shared/types";

type Mode = "login" | "signup" | "forgot-request" | "forgot-verify" | "forgot-done";

export function AuthScreen({ state }: { state: AuthState }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmitLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await window.aw.login(email, password);
    setLoading(false);
    if (!res.ok) setError(res.error ?? "Login failed");
  }

  async function onSubmitSignup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await window.aw.signup(email, password);
    setLoading(false);
    if (!res.ok) setError(res.error ?? "Sign up failed");
  }

  async function onGoogle() {
    setError(null);
    setLoading(true);
    const res = await window.aw.startGoogleSignIn();
    setLoading(false);
    if (!res.ok) setError(res.error ?? "Google sign-in failed");
  }

  // Forgot-password reuses the existing passwordless email-code login as
  // its recovery path (Frederico's 2026-11-13 decision on the card) —
  // there is no separate reset-password flow.
  async function onRequestCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await window.aw.startEmailCode(email);
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? "Could not send a code");
      return;
    }
    setMode("forgot-verify");
  }

  async function onVerifyCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await window.aw.verifyEmailCode(email, code);
    setLoading(false);
    if (!res.ok) setError(res.error ?? "That code is wrong or has expired");
  }

  if (mode === "forgot-request" || mode === "forgot-verify") {
    return (
      <div className="shell">
        <Wordmark />
        <div className="card">
          <strong>Sign in with a code</strong>
          {mode === "forgot-request" ? (
            <form onSubmit={onRequestCode} className="card" style={{ padding: 0, border: "none" }}>
              <input
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && <span className="error">{error}</span>}
              <button className="primary" disabled={loading} type="submit">
                {loading ? "Sending…" : "Send sign-in code"}
              </button>
            </form>
          ) : (
            <form onSubmit={onVerifyCode} className="card" style={{ padding: 0, border: "none" }}>
              <span className="dim">We sent a 6-digit code to {email}.</span>
              <input
                required
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              {error && <span className="error">{error}</span>}
              <button className="primary" disabled={loading} type="submit">
                {loading ? "Verifying…" : "Verify & sign in"}
              </button>
            </form>
          )}
          <button className="link" onClick={() => setMode("login")}>
            ← Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Wordmark />
      <div className="card">
        <div className="tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Log in
          </button>
          <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Create account
          </button>
        </div>

        <form onSubmit={mode === "signup" ? onSubmitSignup : onSubmitLogin} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {state.error && !error && <span className="error">{readableError(state.error)}</span>}
          {error && <span className="error">{error}</span>}
          <button className="primary" disabled={loading} type="submit">
            {loading ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>
        </form>

        <button className="secondary" onClick={onGoogle} disabled={loading}>
          Continue with Google
        </button>

        {mode === "login" && (
          <button className="link" onClick={() => setMode("forgot-request")}>
            Forgot password?
          </button>
        )}
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="wordmark">
      <span className="chevron">❯</span> aw
    </div>
  );
}

function readableError(code: string): string {
  if (code === "session_expired") return "Your session expired. Please sign in again.";
  if (code === "session_lost") return "Something went wrong. Please sign in again.";
  return code;
}
