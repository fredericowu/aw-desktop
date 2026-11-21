import { useCallback, useEffect, useState } from "react";
import type { DepStatus, DepsSnapshot } from "../../shared/deps";

const STATE_LABEL: Record<DepStatus["state"], string> = {
  installed: "Installed",
  missing: "Missing",
  installing: "Installing…",
  waiting: "Waiting for you…",
  failed: "Failed",
};

export const DEPS_POLL_MS = 3000;

/** Lists everything a local workspace needs, re-checks on its own, and installs
 * an item only after the user clicks its button (the plan is shown first). */
export function Dependencies({ onReady }: { onReady: (ready: boolean) => void }) {
  const [snap, setSnap] = useState<DepsSnapshot | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await window.aw.depsList();
      setSnap(next);
      onReady(next.ready);
    } finally {
      setChecking(false);
    }
  }, [onReady]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), DEPS_POLL_MS);
    const off = window.aw.onDepsChanged(() => void refresh());
    return () => {
      clearInterval(t);
      off();
    };
  }, [refresh]);

  if (!snap) return <span className="dim" data-testid="deps-loading">Checking your machine…</span>;

  return (
    <div data-testid="deps">
      {!snap.supported && (
        <span className="error" data-testid="deps-unsupported">
          Setting up a local sandbox from here is only available on Apple Silicon Macs right now. {snap.platform === "win32" ? "Windows is not implemented yet (untested)." : ""}
        </span>
      )}
      {snap.interrupted && (
        <span className="dim" data-testid="deps-interrupted">
          A previous install was interrupted when the app closed. Nothing partial is kept: install it again below.
        </span>
      )}
      <ul className="runtime-list">
        {snap.items.map((it) => (
          <DepRow key={it.id} it={it} blocked={it.after?.some((a) => snap.items.find((x) => x.id === a)?.state !== "installed") ?? false} onChanged={() => void refresh()} />
        ))}
      </ul>
      <span className="dim" data-testid="deps-live">{checking ? "Checking…" : "Checking every 3 seconds."}</span>
    </div>
  );
}

function DepRow({ it, blocked, onChanged }: { it: DepStatus; blocked: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const canInstall = (it.state === "missing" || it.state === "failed") && it.plan && !blocked;
  async function install() {
    setBusy(true);
    try {
      await window.aw.depsInstall(it.id, true);
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  return (
    <li className="runtime-row" data-testid={`dep-${it.id}`} data-state={it.state} style={{ display: "block" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div>
            {it.title} {it.required ? <span className="dim">(required)</span> : <span className="dim">(optional)</span>}
          </div>
          <div className="dim">{it.sub}</div>
        </div>
        <span className={it.state === "installed" ? "ok" : "dim"} data-testid={`dep-${it.id}-state`}>
          {STATE_LABEL[it.state]}
          {it.state === "installing" && it.progress !== undefined ? ` ${it.progress}%` : ""}
        </span>
      </div>
      {it.state === "installing" && (
        <div style={{ height: 6, background: "#30363d", borderRadius: 3, marginTop: 8 }} role="progressbar" aria-valuenow={it.progress ?? 0}>
          <div style={{ width: `${it.progress ?? 0}%`, height: "100%", background: "#f5a623", borderRadius: 3 }} />
        </div>
      )}
      {it.state === "waiting" && it.hint && <div className="dim" data-testid={`dep-${it.id}-hint`}>{it.hint}</div>}
      {it.error && <div className="error" data-testid={`dep-${it.id}-error`}>Install failed: {it.error}</div>}
      {(it.state === "missing" || it.state === "failed") && it.plan && (
        <dl className="dim" data-testid={`dep-${it.id}-plan`} style={{ margin: "8px 0" }}>
          <div>Download: {it.plan.source}</div>
          <div>Size: {it.plan.size}</div>
          <div>Checksum: {it.plan.checksum}</div>
          <div>Goes to: {it.plan.dest}</div>
        </dl>
      )}
      {it.note && it.state !== "installed" && <div className="dim">{it.note}</div>}
      {canInstall && (
        <button className="secondary" disabled={busy} data-testid={`dep-${it.id}-install`} onClick={() => void install()}>
          {it.state === "failed" ? "Retry" : "Download and install"}
        </button>
      )}
      {blocked && (it.state === "missing" || it.state === "failed") && it.plan && <div className="dim">Install the item above first.</div>}
    </li>
  );
}
