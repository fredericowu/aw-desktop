import { describe, expect, it } from "vitest";
import {
  AW_REMOTE_HOST_VERSION,
  assetName,
  parseChecksums,
  parseStatus,
  sha256Hex,
  verifyChecksum,
} from "../src/main/bootstrapCore";
import {
  advance,
  appendLine,
  complete,
  decidePreflight,
  fail,
  redact,
  rowState,
  startProgress,
  stepFromLine,
} from "../src/shared/bootstrapState";
import type { LocalHostStatus, WorkspaceInfo } from "../src/shared/types";

const bytes = new TextEncoder().encode("hello");
const HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const asset = "aw-remote-host_v0.1.150_darwin_arm64.tar.gz";

describe("checksum verification", () => {
  const txt = `${HELLO}  ${asset}\n${"a".repeat(64)}  other.tar.gz\n`;
  it("accepts a matching sha256", () => {
    expect(sha256Hex(bytes)).toBe(HELLO);
    expect(() => verifyChecksum(bytes, txt, asset)).not.toThrow();
  });
  it("rejects a mismatch", () => {
    expect(() => verifyChecksum(new TextEncoder().encode("tampered"), txt, asset)).toThrow(/checksum mismatch/);
  });
  it("rejects when the asset is not listed (never passes by omission)", () => {
    expect(() => verifyChecksum(bytes, `${"a".repeat(64)}  other.tar.gz`, asset)).toThrow(/no checksum listed/);
  });
  it("parses sha256sum format incl. binary marker and ignores junk", () => {
    const m = parseChecksums(`junk\n${HELLO} *${asset}\n`);
    expect(m.get(asset)).toBe(HELLO);
    expect(m.size).toBe(1);
  });
  it("builds the release asset name for mac archs and refuses others", () => {
    expect(assetName(AW_REMOTE_HOST_VERSION, "darwin", "arm64")).toBe(asset);
    expect(assetName("v1", "darwin", "x64")).toBe("aw-remote-host_v1_darwin_amd64.tar.gz");
    expect(() => assetName("v1", "win32", "x64")).toThrow(/unsupported/);
  });
});

describe("status parsing", () => {
  it("not linked", () => {
    expect(parseStatus("2026-11-20T10:00:00Z linked: no (no credentials found)\n")).toEqual({ linked: false });
  });
  it("linked with workspace, provisioned", () => {
    const out = [
      "2026-11-20T10:00:00Z linked: yes (remote_host_id=rh_123)",
      "2026-11-20T10:00:00Z workspace: fredericowu",
      "2026-11-20T10:00:00Z provisioned: yes",
    ].join("\n");
    expect(parseStatus(out)).toEqual({ linked: true, remoteHostId: "rh_123", workspaceSlug: "fredericowu", provisioned: true });
  });
  it("lean link reports provisioned no", () => {
    const r = parseStatus("linked: yes (remote_host_id=x)\nworkspace: a\nprovisioned: no (lean link)");
    expect(r.provisioned).toBe(false);
  });
  it("unparseable output is unknown-and-linked, never clean", () => {
    expect(parseStatus("segfault")).toEqual({ linked: true, unknown: true });
  });
});

const host = (o: Partial<LocalHostStatus>): LocalHostStatus => ({ binary: true, linked: false, ...o });
const row = (o: Partial<WorkspaceInfo>): WorkspaceInfo => ({ name: "w", placement_driver: "remote-host", is_hosted: false, status: "provisioning", ...o });

describe("pre-flight guard", () => {
  it("proceeds with a token on a clean Mac", () => {
    expect(decidePreflight(host({}))).toEqual({ action: "proceed", needsToken: true });
  });
  it("blocks a new create on a linked Mac, naming the workspace", () => {
    const r = decidePreflight(host({ linked: true, workspaceSlug: "fredericowu" }));
    expect(r.action).toBe("block");
    expect(r.action === "block" && r.message).toContain("fredericowu");
  });
  it("blocks when state is unknown", () => {
    expect(decidePreflight(host({ linked: true, unknown: true })).action).toBe("block");
  });
  it("resuming the SAME workspace proceeds without minting a token", () => {
    expect(decidePreflight(host({ linked: true, workspaceSlug: "w", remoteHostId: "rh_1" }), "w", "rh_1")).toEqual({ action: "proceed", needsToken: false });
  });
  it("resuming a different slug on a linked Mac is blocked", () => {
    expect(decidePreflight(host({ linked: true, workspaceSlug: "other" }), "w").action).toBe("block");
  });
});

describe("partial registration (credential saved, slug write failed)", () => {
  const h = host({ linked: true, remoteHostId: "rh_1" });
  it("same host id on the row => proceeds, no token", () => {
    expect(decidePreflight(h, "w", "rh_1")).toEqual({ action: "proceed", needsToken: false });
  });
  it("different or missing row host id => blocked", () => {
    expect(decidePreflight(h, "w", "rh_2").action).toBe("block");
    expect(decidePreflight(h, "w", null).action).toBe("block");
    expect(decidePreflight(h, "w").action).toBe("block");
  });
  it("same slug but the row's host id differs/is missing (other control plane) => blocked", () => {
    const same = host({ linked: true, workspaceSlug: "w", remoteHostId: "rh_1" });
    expect(decidePreflight(same, "w", "rh_other").action).toBe("block");
    expect(decidePreflight(same, "w", null).action).toBe("block");
    expect(decidePreflight(same, "w").action).toBe("block");
    expect(decidePreflight(host({ linked: true, workspaceSlug: "w" }), "w", "rh_1").action).toBe("block");
  });
  it("a host that reports a DIFFERENT workspace is never matched by host id", () => {
    expect(decidePreflight(host({ linked: true, remoteHostId: "rh_1", workspaceSlug: "x" }), "w", "rh_1").action).toBe("block");
  });
  it("rowState: finish when the row is bound to this host, blocked otherwise", () => {
    expect(rowState(row({ remote_host_id: "rh_1" }), h)).toBe("finish");
    expect(rowState(row({ remote_host_id: "rh_2" }), h)).toBe("blocked");
  });
});

describe("resume state machine (rowState)", () => {
  it("running with the same slug but a different host id => open-remote", () => {
    expect(rowState(row({ status: "running", remote_host_id: "other" }), host({ linked: true, workspaceSlug: "w", remoteHostId: "rh_1" }))).toBe("open-remote");
    expect(rowState(row({ status: "running", remote_host_id: null }), host({ linked: true, workspaceSlug: "w", remoteHostId: "rh_1" }))).toBe("open-remote");
  });
  it("running + linked here => open-here", () => {
    expect(rowState(row({ status: "running", remote_host_id: "rh_1" }), host({ linked: true, workspaceSlug: "w", remoteHostId: "rh_1" }))).toBe("open-here");
  });
  it("running elsewhere => open-remote", () => {
    expect(rowState(row({ status: "running" }), host({ linked: true, workspaceSlug: "x" }))).toBe("open-remote");
    expect(rowState(row({ status: "running" }), host({}))).toBe("open-remote");
    expect(rowState(row({ status: "running" }), null)).toBe("open-remote");
  });
  it("pending on a clean Mac => finish", () => {
    expect(rowState(row({}), host({}))).toBe("finish");
    expect(rowState(row({}), null)).toBe("finish");
  });
  it("pending and linked to itself (quit mid-bootstrap) => finish", () => {
    expect(rowState(row({ remote_host_id: "rh_1" }), host({ linked: true, workspaceSlug: "w", remoteHostId: "rh_1" }))).toBe("finish");
  });
  it("pending while this Mac hosts another workspace => blocked", () => {
    expect(rowState(row({}), host({ linked: true, workspaceSlug: "x" }))).toBe("blocked");
  });
});

describe("progress", () => {
  it("redacts tokens", () => {
    expect(redact("--token awbs_abc-123_X ok awlk_zz")).toBe("--token [redacted] ok [redacted]");
  });
  it("maps module lines to steps and never moves backwards", () => {
    expect(stepFromLine("2026 podman: already ok, skipped install")).toBe("podman");
    expect(stepFromLine("redis: installed and verified")).toBe("redis");
    let p = startProgress("w");
    p = appendLine(p, "postgres: installed and verified");
    expect(p.step).toBe("postgres");
    expect(p.done).toEqual(["cli", "token", "link", "podman"]);
    p = appendLine(p, "podman: late line");
    expect(p.step).toBe("postgres");
  });
  it("appendLine redacts and caps the buffer", () => {
    let p = startProgress("w");
    for (let i = 0; i < 50; i++) p = appendLine(p, `line ${i} awbs_secret`);
    expect(p.lines.length).toBe(30);
    expect(p.lines.join("\n")).not.toContain("awbs_secret");
  });
  it("fail records the failing step; complete finishes all", () => {
    const p = fail(advance(startProgress("w"), "podman"), "boom awbs_x");
    expect(p).toMatchObject({ phase: "failed", failedStep: "podman", error: "boom [redacted]" });
    expect(complete(p).phase).toBe("done");
  });
});
