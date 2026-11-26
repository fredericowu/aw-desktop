/** Silent preflight result. Copy is plain language: no engine or VM wording reaches the user. */
export type PreflightCode =
  | "virtualization_unavailable"
  | "low_disk"
  | "low_memory"
  | "engine_missing"
  | "path_too_long"
  | "wsl_missing"
  | "wsl_unresponsive"
  | "ssh_missing";

export interface PreflightResult {
  ok: boolean;
  code?: PreflightCode;
  /** User-facing message when !ok. */
  message?: string;
  /** Guided steps for a prerequisite the user can fix (Windows: WSL). Shown under the message. */
  steps?: string[];
}
