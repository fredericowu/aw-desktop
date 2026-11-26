import { failureCopy, hostForPlatform, type FailureCode, type Host } from "../shared/errorCopy";

export interface ClassifiedError {
  code: FailureCode;
  /** Plain-language copy for the user. Never contains raw stderr. */
  message: string;
  /** Raw text for the diagnostics log only. */
  raw: string;
}

// Order matters: first match wins. Engine stderr changes between versions, so every rule is
// deliberately narrow. Anything unmatched falls to start_failed, never a specific wrong message.
const RULES: Array<[FailureCode, RegExp]> = [
  ["low_disk", /no space left on device|disk quota exceeded|not enough (free )?(disk )?space|ENOSPC/i],
  ["low_memory", /cannot allocate memory|out of memory|not enough memory|ENOMEM|insufficient memory/i],
  // Our own runner's deadline (Windows: WSL can hang instead of failing). Before the generic rules so a timeout whose
  // text also mentions a network word is still reported as "not responding".
  ["engine_unresponsive", /timed out after \d+s/i],
  ["virtualization_unavailable", /HCS_E_HYPERV_NOT_INSTALLED|WSL2? is not supported|virtualization.*(disabled|not enabled)|hypervisor|virtualization (is )?(not )?(available|supported|enabled)|hv_support|vfkit.*(not supported|unsupported)|HV_UNSUPPORTED/i],
  ["wsl_missing", /WSL.*not (installed|enabled)|wsl\.exe.*(not found|cannot find)|Windows Subsystem for Linux has no installed distributions|enable the Windows Subsystem|ERROR_FILE_NOT_FOUND.*wsl/i],
  [
    "download_failed",
    /pulling image|unable to pull|error pulling|image pull|manifest unknown|dial tcp.*(timeout|lookup|refused|unreachable)|no such host|i\/o timeout|TLS handshake timeout|network is unreachable|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporary failure in name resolution|failed to fetch|status code 5\d\d/i,
  ],
];

export function classifyError(err: unknown, host: Host = hostForPlatform(process.platform)): ClassifiedError {
  let raw: string;
  if (err instanceof Error) {
    const r = (err as { result?: { stderr?: string; stdout?: string } }).result;
    raw = [err.message, r?.stderr, r?.stdout].filter(Boolean).join("\n");
  } else {
    raw = String(err ?? "");
  }
  const hit = RULES.find(([, re]) => re.test(raw));
  const code: FailureCode = hit ? hit[0] : "start_failed";
  return { code, message: failureCopy(code, undefined, host), raw };
}

/** True when text is raw engine output that must never be shown (used to guard fall-through messages). */
export function looksLikeEngineText(s: string): boolean {
  return /podman|\bvfkit\b|gvproxy|\bmachine\b|\bcontainer\b|\bexit \d+|stderr|\.sock\b/i.test(s);
}
