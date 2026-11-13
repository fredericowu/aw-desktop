export function Splash({ label }: { label: string }) {
  return (
    <div className="shell">
      <div className="wordmark">
        <span className="chevron">❯</span> aw
      </div>
      <div className="spinner" />
      <div className="dim">{label}</div>
    </div>
  );
}
