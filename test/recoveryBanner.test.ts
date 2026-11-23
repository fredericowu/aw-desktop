import { describe, expect, it } from "vitest";
import { BANNER_COPY, RecoveryBanner, bannerFor, bannerHtml, type BannerState } from "../src/main/recoveryBanner";
import type { SupervisedStatus } from "../src/main/supervisorCore";

function mk(initial: Record<string, SupervisedStatus | null> = {}, retryImpl?: (id: string) => Promise<boolean>) {
  const status: Record<string, SupervisedStatus | null> = { ...initial };
  const renders: BannerState[] = [];
  const retries: string[] = [];
  const b = new RecoveryBanner({
    view: { render: (s) => void renders.push(s) },
    statusOf: (id) => status[id] ?? null,
    retry: async (id) => {
      retries.push(id);
      return retryImpl ? retryImpl(id) : true;
    },
  });
  return { b, status, renders, retries };
}

describe("bannerFor", () => {
  it("maps statuses", () => {
    expect(bannerFor("running").kind).toBe("hidden");
    expect(bannerFor(null).kind).toBe("hidden");
    expect(bannerFor("starting")).toEqual({ kind: "recovering", text: BANNER_COPY.recovering });
    expect(bannerFor("needs_attention")).toEqual({ kind: "attention", text: BANNER_COPY.attention, canRetry: true });
  });
});

describe("RecoveryBanner state machine", () => {
  it("shows progress, then Needs attention, then auto-dismisses on recovered", () => {
    const { b, renders } = mk();
    b.setOpen("w");
    b.onStatus("w", "starting");
    expect(b.state().kind).toBe("recovering");
    b.onStatus("w", "needs_attention");
    expect(b.state().kind).toBe("attention");
    b.onStatus("w", "running");
    expect(b.state().kind).toBe("hidden");
    expect(renders.map((r) => r.kind)).toEqual(["recovering", "attention", "hidden"]);
  });

  it("ignores other workspaces and a closed window", () => {
    const { b, renders } = mk();
    b.setOpen("w");
    b.onStatus("other", "needs_attention");
    expect(renders).toEqual([]);
    b.setOpen(null);
    b.onStatus("w", "starting");
    expect(b.state().kind).toBe("hidden");
  });

  it("a window opened mid-recovery shows the current status at once", () => {
    const { b } = mk({ w: "starting" });
    b.setOpen("w");
    expect(b.state().kind).toBe("recovering");
  });

  it("Retry shows progress, uses the retry action, and dismisses when recovered", async () => {
    const { b, status, retries, renders } = mk({ w: "needs_attention" }, async (id) => ((status_ref.s[id] = "running"), true));
    const status_ref = { s: status };
    b.setOpen("w");
    await b.retry();
    expect(retries).toEqual(["w"]);
    expect(renders.map((r) => r.kind)).toEqual(["attention", "recovering", "hidden"]);
  });

  it("failed Retry returns to Needs attention with Retry available", async () => {
    const { b, renders } = mk({ w: "needs_attention" }, async () => false);
    b.setOpen("w");
    await b.retry();
    expect(renders.map((r) => r.kind)).toEqual(["attention", "recovering", "attention"]);
    expect(b.state()).toMatchObject({ kind: "attention", canRetry: true });
  });

  it("Retry is ignored unless Needs attention, and not re-entered while running", async () => {
    const { b, retries } = mk({ w: "starting" });
    b.setOpen("w");
    await b.retry();
    expect(retries).toEqual([]);
    const m = mk({ w: "needs_attention" }, () => new Promise(() => undefined));
    m.b.setOpen("w");
    void m.b.retry();
    await m.b.retry();
    expect(m.retries).toEqual(["w"]);
  });
});

describe("banner copy", () => {
  it("is plain language: no engine wording, no raw errors, Retry only on attention", () => {
    const pages = [bannerFor("starting"), bannerFor("needs_attention")].map(bannerHtml).join(" ");
    expect(pages).not.toMatch(/podman|\bvm\b|container|image|stderr|exit code/i);
    expect(bannerHtml(bannerFor("starting"))).not.toContain("Retry");
    expect(bannerHtml(bannerFor("needs_attention"))).toContain("Retry");
    expect(bannerHtml({ kind: "hidden" })).not.toContain("role=\"status\"");
  });
  it("escapes text", () => {
    expect(bannerHtml({ kind: "recovering", text: "<b>x</b>" })).not.toContain("<b>x");
  });
});
