/** Silent preflight result. Copy is plain language: no engine or VM wording reaches the user. */
export type PreflightCode =
  | "virtualization_unavailable"
  | "low_disk"
  | "low_memory"
  | "engine_missing"
  | "path_too_long";

export interface PreflightResult {
  ok: boolean;
  code?: PreflightCode;
  /** User-facing message when !ok. */
  message?: string;
}
