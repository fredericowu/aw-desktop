import type { AuthState } from "../../shared/types";

export function Picker({ state }: { state: AuthState }) {
  const memberships = state.user?.memberships ?? [];

  return (
    <div className="shell">
      <div className="wordmark">
        <span className="chevron">❯</span> aw
      </div>
      <div className="card">
        <strong>Choose a workspace</strong>
        <div className="workspace-list">
          {memberships.map((m) => (
            <button
              key={m.workspace}
              className="secondary"
              onClick={() => window.aw.pickWorkspace(m.workspace)}
            >
              {m.workspace} <span className="dim">· {m.role}</span>
            </button>
          ))}
        </div>
        <button className="link" onClick={() => window.aw.createWorkspace()}>
          + Create a new workspace
        </button>
        <button className="link" onClick={() => window.aw.logout()}>
          Log out
        </button>
      </div>
    </div>
  );
}
