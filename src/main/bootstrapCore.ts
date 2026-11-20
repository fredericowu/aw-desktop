import { createHash } from "node:crypto";
import type { LocalHostStatus } from "../shared/types";

/** Pinned aw-remote-host release (tekflox/aw-remote-host). Bump deliberately:
 * the desktop pins the host agent instead of trusting "latest". The binary is
 * NOT bundled in the .app (it self-updates in place, which would break the
 * notarized signature); it is installed to ~/.local/bin like install.sh does. */
export const AW_REMOTE_HOST_VERSION = "v0.1.150";
export const AW_REMOTE_HOST_REPO = "tekflox/aw-remote-host";

export function assetName(version: string, platform: string, arch: string): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const a = arch === "x64" || arch === "x86_64" || arch === "amd64" ? "amd64" : arch === "arm64" || arch === "aarch64" ? "arm64" : null;
  if (!os || !a) throw new Error(`unsupported platform ${platform}/${arch}`);
  return `aw-remote-host_${version}_${os}_${a}.tar.gz`;
}

export function releaseUrl(version: string, file: string): string {
  return `https://github.com/${AW_REMOTE_HOST_REPO}/releases/download/${version}/${file}`;
}

/** checksums.txt is `<sha256>  <file>` per line (sha256sum format). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(raw.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Throws unless `buf` hashes to the checksum listed for `asset`. A missing
 * entry is a failure, never a pass. */
export function verifyChecksum(buf: Uint8Array, checksumsTxt: string, asset: string): void {
  const expected = parseChecksums(checksumsTxt).get(asset);
  if (!expected) throw new Error(`no checksum listed for ${asset}`);
  const actual = sha256Hex(buf);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
}

/** Parses `aw-remote-host status` output (rlog lines carry a timestamp
 * prefix, so match mid-line). Unparseable output => unknown. */
export function parseStatus(output: string): Omit<LocalHostStatus, "binary"> {
  const linked = /(?:^|\s)linked: (yes|no)\b/m.exec(output);
  if (!linked) return { linked: true, unknown: true };
  if (linked[1] === "no") return { linked: false };
  const id = /remote_host_id=([^\s)]+)/.exec(output)?.[1];
  const slug = /(?:^|\s)workspace: (\S+)\s*$/m.exec(output)?.[1];
  const prov = /(?:^|\s)provisioned: (yes|no)\b/m.exec(output);
  return {
    linked: true,
    remoteHostId: id,
    workspaceSlug: slug,
    provisioned: prov ? prov[1] === "yes" : undefined,
  };
}

export * from "../shared/bootstrapState";
