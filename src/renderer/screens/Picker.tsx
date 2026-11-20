import { useCallback, useEffect, useState } from "react";
import type {
  AccountInfo,
  ApiResult,
  AuthState,
  RuntimeCheck,
  RuntimeKind,
  WorkspaceInfo,
} from "../../shared/types";
import {
  DEFAULT_LOCAL_LIMIT,
  isPlanLimitCode,
  isSetupPending,
  splitWorkspaces,
} from "../../shared/workspaces";

const CLOUD_UNAVAILABLE = "Feature is not available at this time.";

const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  podman: "Podman",
  "docker-desktop": "Docker Desktop",
  colima: "Colima",
};

type Load =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; workspaces: WorkspaceInfo[]; account: AccountInfo | null };

type Modal =
  | null
  | { kind: "limit"; limit: number }
  | { kind: "wizard" };

export function Picker({ state }: { state: AuthState }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [modal, setModal] = useState<Modal>(null);

  const refresh = useCallback(async () => {
    setLoad({ phase: "loading" });
    const res = await window.aw.listWorkspaces();
    if (res.ok && res.data) {
      setLoad({ phase: "ready", workspaces: res.data.workspaces, account: res.data.account });
    } else {
      setLoad({ phase: "error", message: res.error ?? "Could not load your sandboxes." });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = load.phase === "ready" ? load : null;
  const { local, cloud } = splitWorkspaces(ready?.workspaces ?? []);
  const limit = ready?.account?.limits?.max_local_workspaces ?? DEFAULT_LOCAL_LIMIT;
  // The server count is authoritative (it counts only OWNED local rows);
  // fall back to what we can see when the backend predates local_count.
  const serverCount = ready?.account?.local_count;
  const localCount = serverCount ?? local.length;

  function onCreateLocal() {
    // Cap gate first: no runtime check, no API call when already at the cap.
    // Only gate on the authoritative owned count: the list also holds shared
    // memberships, so without it the server decides (402 -> limit modal).
    if (serverCount !== undefined && serverCount >= limit) setModal({ kind: "limit", limit });
    else setModal({ kind: "wizard" });
  }

  return (
    <div className="shell picker-shell">
      <div className="wordmark">
        <span className="chevron">❯</span> aw
      </div>
      <div className="picker-head">
        <strong>Your sandboxes</strong>
        <span className="dim">Choose one to open, or create a new one.</span>
      </div>

      {load.phase === "loading" && (
        <div className="picker-loading">
          <div className="spinner" />
          <span className="dim">Loading your sandboxes…</span>
        </div>
      )}

      {load.phase === "error" && (
        <div className="card picker-block">
          <span className="error">{load.message}</span>
          <button className="secondary" onClick={() => void refresh()}>
            Try again
          </button>
          {/* The list call failing must not lock the user out of what they
              already own: fall back to the memberships from /me. */}
          {(state.user?.memberships ?? []).map((m) => (
            <button key={m.workspace} className="secondary" onClick={() => window.aw.pickWorkspace(m.workspace)}>
              {m.workspace} <span className="dim">· {m.role}</span>
            </button>
          ))}
        </div>
      )}

      {ready && (
        <>
          <section className="card picker-block" data-testid="local-block">
            <div className="block-head">
              <div>
                <strong>Local</strong>
                <div className="dim">Runs on this machine.</div>
              </div>
              <span className="badge" data-testid="local-badge">
                {localCount}/{limit}
              </span>
            </div>
            {local.length === 0 ? (
              <span className="dim">No local sandboxes yet — create one to get started.</span>
            ) : (
              <div className="workspace-list">
                {local.map((ws) => (
                  <WorkspaceRow key={ws.name} ws={ws} />
                ))}
              </div>
            )}
            <button className="secondary" onClick={onCreateLocal}>
              + Create new sandbox
            </button>
          </section>

          <section className="card picker-block" data-testid="cloud-block">
            <div className="block-head">
              <div>
                <strong>Cloud</strong>
                <div className="dim">Hosted by us.</div>
              </div>
              <span className="badge muted">Coming soon</span>
            </div>
            {cloud.length === 0 ? (
              <span className="dim">No cloud sandboxes yet.</span>
            ) : (
              <div className="workspace-list">
                {cloud.map((ws) => (
                  <WorkspaceRow key={ws.name} ws={ws} />
                ))}
              </div>
            )}
            {/* Truly disabled: no onClick, so the Cloud path can never reach
                the API. */}
            <button className="secondary" disabled aria-describedby="cloud-caption">
              + Create new sandbox
            </button>
            <span id="cloud-caption" className="dim" data-testid="cloud-caption">
              {CLOUD_UNAVAILABLE}
            </span>
          </section>
        </>
      )}

      <button className="link" onClick={() => window.aw.logout()}>
        Not you? Log out
      </button>

      {modal?.kind === "limit" && <LimitModal limit={modal.limit} onClose={() => setModal(null)} />}
      {modal?.kind === "wizard" && (
        <CreateWizard
          onClose={() => setModal(null)}
          onLimit={(l) => setModal({ kind: "limit", limit: l ?? limit })}
          onCreated={() => {
            setModal(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function WorkspaceRow({ ws }: { ws: WorkspaceInfo }) {
  if (isSetupPending(ws)) {
    return (
      <div className="workspace-row pending" data-testid={`pending-${ws.name}`}>
        <span>{ws.name}</span>
        <span className="dim">Setup pending on this Mac</span>
      </div>
    );
  }
  return (
    <button className="secondary" onClick={() => window.aw.pickWorkspace(ws.name)}>
      {ws.name}
    </button>
  );
}

function LimitModal({ limit, onClose }: { limit: number; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card modal">
        <strong>You've hit your free-tier limit</strong>
        <span className="dim">
          Your plan includes {limit} local sandboxes and you've used them all. Remove one, or upgrade to
          create more.
        </span>
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}

function CreateWizard({
  onClose,
  onLimit,
  onCreated,
}: {
  onClose: () => void;
  onLimit: (limit?: number) => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<"runtime" | "name">("runtime");
  const [check, setCheck] = useState<RuntimeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await window.aw.checkRuntime());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  async function create() {
    setBusy(true);
    setError(null);
    const res: ApiResult<WorkspaceInfo> = await window.aw.createLocalWorkspace(name.trim());
    setBusy(false);
    if (res.ok) return onCreated();
    if (res.status === 402 && isPlanLimitCode(res.code)) return onLimit(res.limit);
    setError(res.error ?? "Could not create the sandbox.");
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card modal">
        {step === "runtime" ? (
          <>
            <span className="dim">Step 1 of 2 — Set up your sandbox</span>
            <strong>Checking your machine</strong>
            <span className="dim">
              A local sandbox runs in a container on this Mac — we're confirming you have what it needs.
            </span>
            <div className="runtime-row" data-testid="runtime-status">
              <div>
                <div>Container runtime</div>
                <div className="dim">Docker Desktop or Podman</div>
              </div>
              <span className={check?.ready ? "ok" : "dim"}>
                {checking || !check ? "Checking…" : check.ready ? "Found" : "Not found"}
              </span>
            </div>
            {check && (
              <ul className="runtime-list">
                {check.runtimes.map((r) => (
                  <li key={r.kind} className="dim">
                    {RUNTIME_LABEL[r.kind]}:{" "}
                    {!r.installed ? "not installed" : r.running ? "running" : "installed, not running"}
                  </li>
                ))}
              </ul>
            )}
            {check && !check.ready && (
              <>
                <span className="dim">
                  Install one of these (or start it if it is already installed), then come back and re-check —
                  you don't need to restart aw.
                </span>
                <div className="guide">
                  <strong>Docker Desktop</strong> <span className="badge">Recommended</span>
                  <div className="dim">The most common choice — includes a GUI for managing containers.</div>
                  <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">
                    Download Docker Desktop ↗
                  </a>
                </div>
                <div className="guide">
                  <strong>Podman</strong>
                  <div className="dim">A lighter, daemon-less alternative — works just as well for running a sandbox.</div>
                  <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer">
                    Download Podman ↗
                  </a>
                </div>
              </>
            )}
            <button className="secondary" onClick={() => void recheck()} disabled={checking}>
              I've installed it — Re-check
            </button>
            <button className="primary" disabled={!check?.ready} onClick={() => setStep("name")}>
              Continue
            </button>
          </>
        ) : (
          <>
            <span className="dim">Step 2 of 2 — Name your sandbox</span>
            <strong>Create a new sandbox</strong>
            <span className="dim">
              Give it a name — it'll run locally on this machine. You can invite teammates once it's created.
            </span>
            <label className="dim" htmlFor="sandbox-name">
              Sandbox name
            </label>
            <input
              id="sandbox-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="my-sandbox"
            />
            {error && <span className="error">{error}</span>}
            <button className="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? "Creating…" : "Create sandbox"}
            </button>
          </>
        )}
        <button className="link" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
