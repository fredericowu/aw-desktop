import { Dependencies } from "./Dependencies";
import { useCallback, useEffect, useState } from "react";
import type {
  AccountInfo,
  ApiResult,
  AuthState,
  BootstrapProgress,
  WorkspaceInfo,
} from "../../shared/types";
import { STEP_LABEL, STEP_ORDER } from "../../shared/bootstrapState";
import {
  DEFAULT_LOCAL_LIMIT,
  isPlanLimitCode,
  splitWorkspaces,
} from "../../shared/workspaces";

const CLOUD_UNAVAILABLE = "Feature is not available at this time.";

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
  const [progress, setProgress] = useState<BootstrapProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Re-sync with a bootstrap that is already running (e.g. window re-opened)
  // and follow its live progress.
  useEffect(() => {
    void window.aw.getBootstrapProgress().then((p) => p && p.phase !== "done" && setProgress(p));
    return window.aw.onBootstrapProgress(setProgress);
  }, []);

  const refresh = useCallback(async () => {
    setLoad({ phase: "loading" });
    const res = await window.aw.listWorkspaces();
    if (res.ok && res.data) {
      setLoad({ phase: "ready", workspaces: res.data.workspaces, account: res.data.account });
    } else {
      setLoad({ phase: "error", message: res.error ?? "Could not load your workspaces." });
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
        <strong>Your workspaces</strong>
        <span className="dim">Choose one to open, or create a new one.</span>
      </div>

      {state.storageWarning && (
        <div className="card picker-block" data-testid="storage-warning">
          <span className="dim">{state.storageWarning}</span>
        </div>
      )}

      {state.openError && (
        <div className="card picker-block" data-testid="open-error" role="alert">
          <span className="error">
            Could not open {state.openError.slug}: {state.openError.message}
          </span>
          <button className="secondary" data-testid="open-retry" onClick={() => void window.aw.pickWorkspace(state.openError!.slug)}>
            Retry
          </button>
        </div>
      )}

      {load.phase === "loading" && (
        <div className="picker-loading">
          <div className="spinner" />
          <span className="dim">Loading your workspaces…</span>
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
              <span className="dim">No local workspaces yet — create one to get started.</span>
            ) : (
              <div className="workspace-list">
                {local.map((ws) => (
                  <WorkspaceRow
                    key={ws.name}
                    ws={ws}
                    onFinish={async () => {
                      setNotice(null);
                      const r = await window.aw.finishLocalSetup(ws.name);
                      if (!r.ok) setNotice(r.error ?? "Could not start setup.");
                    }}
                  />
                ))}
              </div>
            )}
            {notice && <span className="error" data-testid="local-notice">{notice}</span>}
            <button className="secondary" onClick={onCreateLocal}>
              + Create new workspace
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
              <span className="dim">No cloud workspaces yet.</span>
            ) : (
              <div className="workspace-list">
                {cloud.map((ws) => (
                  <WorkspaceRow key={ws.name} ws={ws} onFinish={() => undefined} cloud />
                ))}
              </div>
            )}
            {/* Truly disabled: no onClick, so the Cloud path can never reach
                the API. */}
            <button className="secondary" disabled aria-describedby="cloud-caption">
              + Create new workspace
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

      {progress && (
        <ProgressModal
          progress={progress}
          onRetry={async () => {
            const r = await window.aw.finishLocalSetup(progress.slug);
            return r.ok ? null : (r.error ?? "Could not restart setup.");
          }}
          onClose={() => {
            setProgress(null);
            void refresh();
          }}
        />
      )}
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

function WorkspaceRow({
  ws,
  onFinish,
  cloud,
}: {
  ws: WorkspaceInfo;
  onFinish: () => void;
  cloud?: boolean;
}) {
  const open = (
    <button className="secondary" onClick={() => window.aw.pickWorkspace(ws.name)}>
      {ws.display_name ?? ws.name}
    </button>
  );
  if (cloud) return open;
  const label = ws.display_name ?? ws.name;
  if (ws.status === "running") {
    return (
      <div className="workspace-row" data-testid={`here-${ws.name}`}>
        {open}
        <span className="dim">Runs on this Mac</span>
      </div>
    );
  }
  return (
    <div className="workspace-row pending" data-testid={`pending-${ws.name}`}>
      <span>{label}</span>
      <span className="dim">Not running. Starts a small VM on this Mac.</span>
      <button className="primary" onClick={onFinish}>
        Start
      </button>
    </div>
  );
}

function ProgressModal({
  progress,
  onRetry,
  onClose,
}: {
  progress: BootstrapProgress;
  /** Resolves an error message when the retry was refused before any progress was emitted. */
  onRetry: () => Promise<string | null>;
  onClose: () => void;
}) {
  const failed = progress.phase === "failed";
  const [retryError, setRetryError] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" data-testid="bootstrap-progress">
      <div className="card modal">
        <strong>{failed ? "Setup failed" : progress.phase === "done" ? "Your workspace is ready" : `Setting up ${progress.slug}`}</strong>
        <ul className="runtime-list">
          {STEP_ORDER.map((id) => {
            const state = failed && progress.failedStep === id ? "failed" : progress.done.includes(id) ? "done" : progress.step === id ? "active" : "pending";
            const mark = state === "done" ? "✓" : state === "failed" ? "✗" : state === "active" ? "…" : "·";
            return (
              <li key={id} data-testid={`step-${id}`} data-state={state} className={state === "failed" ? "error" : "dim"}>
                {mark} {STEP_LABEL[id]}
              </li>
            );
          })}
        </ul>
        {failed && (
          <>
            <span className="error" data-testid="bootstrap-error">
              Failed at: {progress.failedStep ? STEP_LABEL[progress.failedStep] : "setup"}. {progress.error}
            </span>
            <pre className="dim" data-testid="bootstrap-log">{progress.lines.slice(-8).join("\n")}</pre>
            {retryError && <span className="error" data-testid="retry-error">{retryError}</span>}
            <button
              className="primary"
              onClick={async () => {
                setRetryError(null);
                setRetryError(await onRetry());
              }}
            >
              Retry
            </button>
            <button className="link" onClick={onClose}>
              Close
            </button>
          </>
        )}
        {!failed && progress.lines.length > 0 && (
          <pre className="dim" data-testid="bootstrap-log">{progress.lines.slice(-3).join("\n")}</pre>
        )}
        {!failed && <span className="dim">This can take several minutes the first time. You can leave this window open.</span>}
      </div>
    </div>
  );
}

function LimitModal({ limit, onClose }: { limit: number; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card modal">
        <strong>You've hit your free-tier limit</strong>
        <span className="dim">
          Your plan includes {limit} local workspaces and you've used them all. Remove one, or upgrade to
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
  const [depsReady, setDepsReady] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    const res: ApiResult<WorkspaceInfo> = await window.aw.createLocalWorkspace(name.trim());
    setBusy(false);
    if (res.ok) return onCreated();
    if (res.status === 402 && isPlanLimitCode(res.code)) return onLimit(res.limit);
    setError(res.error ?? "Could not create the workspace.");
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card modal">
        {step === "runtime" ? (
          <>
            <span className="dim">Step 1 of 2 — Dependencies</span>
            <strong>Set up what your workspace needs</strong>
            <span className="dim">
              A local workspace needs a few things on this Mac. Nothing is installed until you approve it. This list
              updates on its own.
            </span>
            <Dependencies onReady={setDepsReady} />
            <button className="primary" disabled={!depsReady} data-testid="deps-continue" onClick={() => setStep("name")}>
              Continue
            </button>
          </>
        ) : (
          <>
            <span className="dim">Step 2 of 2 — Name your workspace</span>
            <strong>Create a new workspace</strong>
            <span className="dim">
              Give it a name — it'll run locally on this machine. You can invite teammates once it's created.
            </span>
            <label className="dim" htmlFor="sandbox-name">
              Workspace name
            </label>
            <input
              id="sandbox-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="my-workspace"
            />
            {error && <span className="error">{error}</span>}
            <button className="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? "Creating…" : "Create workspace"}
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
