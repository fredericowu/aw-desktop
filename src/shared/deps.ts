/** Dependencies screen model: what a local workspace needs on this Mac. */
export type DepId = "host" | "podman" | "machine";
export type DepState = "installed" | "missing" | "installing" | "waiting" | "failed";

/** Exactly what an install would do, shown to the user BEFORE they approve it. */
export interface DepPlan {
  /** What will be fetched (URL) or run (command). */
  source: string;
  size: string;
  /** Hex sha256, or a description of where it comes from when only known at install time. */
  checksum: string;
  dest: string;
  needsAdmin: boolean;
}

export interface DepStatus {
  id: DepId;
  title: string;
  sub: string;
  required: boolean;
  state: DepState;
  /** 0..100 while installing. */
  progress?: number;
  /** Instruction while `waiting` for the user to finish a GUI/admin step. */
  hint?: string;
  error?: string;
  /** Absent when nothing can be installed from here (machine, unsupported platform). */
  plan?: DepPlan;
  /** Install is possible only after these ids are installed. */
  after?: DepId[];
  /** Why there is no install button (honest copy). */
  note?: string;
}

export interface DepsSnapshot {
  platform: "darwin" | "win32" | "linux" | string;
  /** Windows/Linux paths are listed but not implemented. */
  supported: boolean;
  items: DepStatus[];
  /** Every required item installed: Continue may enable. */
  ready: boolean;
  /** A previous install was cut off by an app quit. */
  interrupted?: DepId;
}
