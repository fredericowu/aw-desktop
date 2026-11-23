import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccountInfo,
  ApiResult,
  AuthState,
  BootstrapProgress,
  WorkspaceInfo,
} from "../../shared/types";
import { STEP_LABEL } from "../../shared/bootstrapState";
import { PHASE_LABEL, failureCopy } from "../../shared/errorCopy";
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

type Removal = { ws: WorkspaceInfo; busy: boolean; error: string | null };

export function Picker({ state }: { state: AuthState }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [modal, setModal] = useState<Modal>(null);
  const [progress, setProgress] = useState<BootstrapProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);

  // Re-sync with a bootstrap that is already running (e.g. window re-opened)
  // and follow its live progress.
  useEffect(() => {
    void window.aw.getBootstrapProgress().then((p) => p && p.phase !== "done" && setProgress(p));
    return window.aw.onBootstrapProgress(setProgress);
  }, []);
  // Supervisor recovery changes a row's status without any user action: merge the row main sends.
  useEffect(() => {
    return window.aw.onWorkspaceStatus?.((row) => {
      setLoad((cur) =>
        cur.phase === "ready" ? { ...cur, workspaces: cur.workspaces.map((w) => (w.name === row.name ? row : w)) } : cur,
      );
    });
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

  async function confirmRemove() {
    if (!removal || removal.busy) return;
    const target = removal.ws;
    setRemoval({ ws: target, busy: true, error: null });
    let res: ApiResult<null>;
    try {
      res = await window.aw.removeLocalWorkspace(target.name);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : undefined };
    }
    if (res.ok) {
      setRemoval(null);
      void refresh(); // the used/limit badge comes from the fresh list
    } else {
      setRemoval({ ws: target, busy: false, error: res.error ?? "Could not remove the workspace." });
    }
  }

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
              <span className="dim">No local workspaces yet. Create one to get started.</span>
            ) : (
              <div className="workspace-list">
                {local.map((ws) => (
                  <WorkspaceRow
                    key={ws.name}
                    ws={ws}
                    onRemove={() => setRemoval({ ws, busy: false, error: null })}
                    removeDisabled={removal?.busy === true}
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
          label={(ready?.workspaces.find((w) => w.name === progress.slug)?.display_name) ?? progress.slug}
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
      {modal?.kind === "limit" && (
        <LimitModal
          limit={modal.limit}
          onClose={() => setModal(null)}
          onRemove={() => {
            setModal(null);
            // Hand the user to the Local list, where each workspace has its Remove button.
            document.querySelector<HTMLElement>('[data-testid="local-block"] [data-remove]')?.focus();
          }}
        />
      )}
      {removal && (
        <RemoveModal
          removal={removal}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoval(null)}
        />
      )}
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
  onRemove,
  removeDisabled,
  cloud,
}: {
  ws: WorkspaceInfo;
  onFinish: () => void;
  onRemove?: () => void;
  removeDisabled?: boolean;
  cloud?: boolean;
}) {
  const label0 = ws.display_name ?? ws.name;
  const remove = onRemove && (
    <button
      className="link"
      data-remove
      data-testid={`remove-${ws.name}`}
      disabled={removeDisabled}
      aria-label={`Remove ${label0}`}
      onClick={onRemove}
    >
      Remove
    </button>
  );
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
        {remove}
      </div>
    );
  }
  if (ws.status === "starting") {
    return (
      <div className="workspace-row pending" data-testid={`starting-${ws.name}`}>
        <span>{label}</span>
        <span className="dim">{ws.detail}</span>
      </div>
    );
  }
  if (ws.status === "needs_attention") {
    return (
      <div className="workspace-row pending" data-testid={`attention-${ws.name}`}>
        <span>{label}</span>
        <span className="dim">{ws.detail}</span>
        <button className="primary" onClick={onFinish}>
          Retry
        </button>
        {remove}
      </div>
    );
  }
  return (
    <div className="workspace-row pending" data-testid={`pending-${ws.name}`}>
      <span>{label}</span>
      <span className="dim">Not running. Starts on this Mac.</span>
      <button className="primary" onClick={onFinish}>
        Start
      </button>
      {remove}
    </div>
  );
}

function ProgressModal({
  progress,
  label,
  onRetry,
  onClose,
}: {
  progress: BootstrapProgress;
  /** Workspace display name; the slug is an internal id and must not reach the UI. */
  label: string;
  /** Resolves an error message when the retry was refused before any progress was emitted. */
  onRetry: () => Promise<string | null>;
  onClose: () => void;
}) {
  const failed = progress.phase === "failed";
  const [retryError, setRetryError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" data-testid="bootstrap-progress">
      <div className="card modal">
        <strong>{failed ? "Setup failed" : progress.phase === "done" ? "Your workspace is ready" : `Setting up ${label}`}</strong>
        {!failed && <span className="dim" data-testid="bootstrap-phase">{progress.step ? STEP_LABEL[progress.step] : PHASE_LABEL.preparing}</span>}
        {failed && (
          <>
            <span className="error" data-testid="bootstrap-error">
              {progress.error ?? failureCopy("start_failed")}
            </span>
            <button className="link" data-testid="copy-details" onClick={async () => setCopied((await window.aw.copyDiagnostics()) ? "Copied." : "Nothing to copy.")}>
              Copy details
            </button>
            {copied && <span className="dim">{copied}</span>}
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
        {!failed && <span className="dim">This can take several minutes the first time. You can leave this window open.</span>}
      </div>
    </div>
  );
}

function RemoveModal({
  removal,
  onConfirm,
  onCancel,
}: {
  removal: Removal;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = removal.ws.display_name ?? removal.ws.name;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" data-testid="remove-modal">
      <div className="card modal">
        <strong>Remove “{name}”?</strong>
        <span className="dim">
          This deletes the workspace “{name}” and all of its data from this Mac, including its database and files.
          This cannot be undone.
        </span>
        {removal.error && (
          <span className="error" data-testid="remove-error" role="alert">
            {removal.error}
          </span>
        )}
        <button className="primary" data-testid="remove-confirm" disabled={removal.busy} onClick={onConfirm}>
          {removal.busy ? "Removing…" : removal.error ? "Retry" : "Remove workspace"}
        </button>
        <button className="link" data-testid="remove-cancel" disabled={removal.busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function LimitModal({ limit, onClose, onRemove }: { limit: number; onClose: () => void; onRemove: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="card modal">
        <strong>You've hit your free-tier limit</strong>
        <span className="dim">
          Your plan includes {limit} local workspaces and you've used them all. Remove one, or upgrade to
          create more.
        </span>
        <button className="primary" data-testid="limit-remove" onClick={onRemove}>
          Remove a workspace
        </button>
        <button className="link" onClick={onClose}>
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
  const [blocked, setBlocked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Silent preflight: no step, no list. Only a failure is ever shown, in plain words.
  const live = useRef(true);
  const check = useCallback(() => {
    window.aw
      .preflight()
      .then((r) => live.current && setBlocked(r.ok ? null : r.message ?? "This Mac can't run local workspaces."))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    live.current = true;
    check();
    return () => {
      live.current = false;
    };
  }, [check]);
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
        <strong>Create a new workspace</strong>
        <span className="dim">
          Give it a name. It'll run locally on this machine. You can invite teammates once it's created.
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
        {blocked && (
          <span className="error" role="alert" data-testid="preflight-blocked">
            {blocked}
          </span>
        )}
        {blocked && (
          <button className="link" data-testid="preflight-recheck" onClick={check}>
            Check again
          </button>
        )}
        {error && <span className="error">{error}</span>}
        <button className="primary" disabled={busy || !!blocked || !name.trim()} onClick={() => void create()}>
          {busy ? "Creating…" : "Create workspace"}
        </button>
        <button className="link" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
