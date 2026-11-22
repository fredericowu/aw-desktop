// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Picker } from "../src/renderer/screens/Picker";
import type { PreflightResult } from "../src/shared/preflight";
import type { ApiResult, AuthState, AwBridge, BootstrapProgress, WorkspaceInfo, WorkspaceListData } from "../src/shared/types";

const state: AuthState = { stage: "picker", user: null, error: null, apex: "aw.tekflox.com" };
const ws = (over: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  name: "w",
  placement_driver: "desktop-local",
  is_hosted: false,
  status: "stopped",
  ...over,
});
let emitProgress: (p: BootstrapProgress) => void = () => undefined;
function bridge(over: Partial<AwBridge> & { workspaces?: WorkspaceInfo[]; localCount?: number } = {}) {
  const { workspaces = [], localCount, ...rest } = over;
  const b = {
    listWorkspaces: vi.fn(
      async (): Promise<ApiResult<WorkspaceListData>> => ({
        ok: true,
        data: {
          workspaces,
          account: { limits: { max_local_workspaces: 2 }, local_count: localCount ?? workspaces.filter((w) => !w.is_hosted).length },
        },
      }),
    ),
    preflight: vi.fn(async (): Promise<PreflightResult> => ({ ok: true })),
    createLocalWorkspace: vi.fn(async (name: string): Promise<ApiResult<WorkspaceInfo>> => ({ ok: true, data: ws({ name }) })),
    pickWorkspace: vi.fn(async () => ({ ok: true })),
    finishLocalSetup: vi.fn(async () => ({ ok: true, data: null })),
    removeLocalWorkspace: vi.fn(async () => ({ ok: true, data: null })),
    getBootstrapProgress: vi.fn(async (): Promise<BootstrapProgress | null> => null),
    onBootstrapProgress: vi.fn((cb: (p: BootstrapProgress) => void) => {
      emitProgress = cb;
      return () => undefined;
    }),
    copyDiagnostics: vi.fn(async () => true),
    logout: vi.fn(async () => undefined),
    ...rest,
  };
  (window as unknown as { aw: unknown }).aw = b;
  return b;
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("Picker landing", () => {
  it("fresh account: Local 0/2 and Cloud, both empty", async () => {
    bridge();
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    expect(screen.getByTestId("local-badge").textContent).toBe("0/2");
    expect(screen.getByText("No local workspaces yet. Create one to get started.")).toBeTruthy();
    expect(screen.getByText("No cloud workspaces yet.")).toBeTruthy();
  });

  it("Cloud create is truly disabled, captioned, and never calls the API", async () => {
    const b = bridge();
    render(<Picker state={state} />);
    const cloud = await screen.findByTestId("cloud-block");
    const btn = cloud.querySelector("button")!;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("cloud-caption").textContent).toContain("Feature is not available at this time");
    fireEvent.click(btn);
    expect(b.createLocalWorkspace).not.toHaveBeenCalled();
    expect(b.preflight).not.toHaveBeenCalled();
  });

  it("a hosted membership shows under Cloud and opens normally", async () => {
    const b = bridge({ workspaces: [ws({ name: "acme", placement_driver: "hosted", is_hosted: true, status: "running" })] });
    render(<Picker state={state} />);
    const cloud = await screen.findByTestId("cloud-block");
    fireEvent.click(cloud.querySelector(".workspace-list button")!);
    expect(b.pickWorkspace).toHaveBeenCalledWith("acme");
  });

  it("a stopped local row is not openable directly and offers Start, which resumes by id and never creates", async () => {
    const b = bridge({ workspaces: [ws({ name: "local1a2b", display_name: "My box" })] });
    render(<Picker state={state} />);
    const row = await screen.findByTestId("pending-local1a2b");
    expect(row.textContent).toContain("My box");
    expect(row.tagName).not.toBe("BUTTON");
    fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(b.finishLocalSetup).toHaveBeenCalledWith("local1a2b"));
    expect(b.createLocalWorkspace).not.toHaveBeenCalled();
    expect(b.pickWorkspace).not.toHaveBeenCalled();
  });

  it("a running local row opens by id and reads 'Runs on this Mac'", async () => {
    const b = bridge({ workspaces: [ws({ name: "local1a2b", display_name: "My box", status: "running" })] });
    render(<Picker state={state} />);
    const row = await screen.findByTestId("here-local1a2b");
    expect(row.textContent).toContain("Runs on this Mac");
    fireEvent.click(row.querySelector("button")!);
    expect(b.pickWorkspace).toHaveBeenCalledWith("local1a2b");
  });

  it("supervisor states: starting shows plain copy, needs attention offers Retry through the normal start path", async () => {
    const b = bridge({
      workspaces: [
        ws({ name: "localaa", display_name: "A", status: "starting", detail: "Starting workspace..." }),
        ws({ name: "localbb", display_name: "B", status: "needs_attention", detail: "This workspace needs attention. Retry, or copy details for support." }),
      ],
    });
    render(<Picker state={state} />);
    expect((await screen.findByTestId("starting-localaa")).textContent).toContain("Starting workspace...");
    const row = screen.getByTestId("attention-localbb");
    expect(row.textContent).toContain("needs attention");
    expect(row.textContent).not.toMatch(/podman|container|machine|engine/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(b.finishLocalSetup).toHaveBeenCalledWith("localbb"));
  });

  it("a status event carries the row, so it updates without any hosted list call", async () => {
    let emit: (r: WorkspaceInfo) => void = () => undefined;
    const b = bridge({
      workspaces: [ws({ name: "localaa", display_name: "A", status: "running" })],
      onWorkspaceStatus: vi.fn((cb: (r: WorkspaceInfo) => void) => ((emit = cb), () => undefined)),
    });
    render(<Picker state={state} />);
    await screen.findByTestId("here-localaa");
    b.listWorkspaces.mockImplementation(async () => ({ ok: false, error: "hosted outage" }));
    emit(ws({ name: "localaa", display_name: "A", status: "needs_attention", detail: "This workspace needs attention. Retry, or copy details for support." }));
    expect(await screen.findByTestId("attention-localaa")).toBeTruthy();
  });

  it("a done snapshot from main does not resurface the ready modal when the picker remounts", async () => {
    bridge({
      getBootstrapProgress: vi.fn(async (): Promise<BootstrapProgress | null> => ({
        slug: "mine", phase: "done", step: "running", done: [], lines: [],
      })),
    });
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    expect(screen.queryByTestId("bootstrap-progress")).toBeNull();
  });

  it("Retry shows the refusal when it fails before emitting progress", async () => {
    const b = bridge({
      finishLocalSetup: vi.fn(async () => ({ ok: false, code: "bootstrap_running", error: "A setup is already running on this Mac." })),
    });
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    emitProgress({ slug: "mine", phase: "failed", step: "podman", done: [], failedStep: "podman", error: "boom", lines: [] });
    fireEvent.click(await screen.findByText("Retry"));
    const msg = await screen.findByTestId("retry-error");
    expect(msg.textContent).toContain("already running");
    expect(b.finishLocalSetup).toHaveBeenCalledWith("mine");
  });

  it("bootstrap failure shows plain copy only, Copy details and Retry", async () => {
    const b = bridge({ copyDiagnostics: vi.fn(async () => true) });
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    emitProgress({
      slug: "mine",
      phase: "failed",
      step: "image",
      done: ["machine"],
      failedStep: "image",
      error: "Couldn't download the workspace. Check your connection and try again.",
      errorCode: "download_failed",
      lines: [],
    });
    const err = await screen.findByTestId("bootstrap-error");
    expect(err.textContent).toContain("Couldn't download the workspace");
    expect(screen.queryByTestId("bootstrap-log")).toBeNull();
    fireEvent.click(screen.getByTestId("copy-details"));
    await screen.findByText("Copied.");
    expect(b.copyDiagnostics).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Retry"));
    expect(b.finishLocalSetup).toHaveBeenCalledWith("mine");
  });

  it("running progress collapses to two plain phases", async () => {
    bridge();
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    emitProgress({ slug: "mine", phase: "running", step: "image", done: ["machine"], lines: [] });
    expect((await screen.findByTestId("bootstrap-phase")).textContent).toBe("Preparing your workspace");
    emitProgress({ slug: "mine", phase: "running", step: "redis", done: ["machine", "image", "postgres"], lines: [] });
    await waitFor(() => expect(screen.getByTestId("bootstrap-phase").textContent).toBe("Starting workspace"));
  });

  it("at the cap, Create shows the limit modal with no preflight or create", async () => {
    const b = bridge({ workspaces: [ws({ name: "a" }), ws({ name: "b" })] });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await screen.findByText("You've hit your free-tier limit");
    expect(b.preflight).not.toHaveBeenCalled();
    expect(b.createLocalWorkspace).not.toHaveBeenCalled();
  });
});

describe("review fixes", () => {
  it("without an authoritative local_count (shared rows visible) the server decides, no client gate", async () => {
    const b = bridge({
      workspaces: [ws({ name: "a" }), ws({ name: "b" })],
      listWorkspaces: vi.fn(async (): Promise<ApiResult<WorkspaceListData>> => ({
        ok: true,
        data: { workspaces: [ws({ name: "a" }), ws({ name: "b" })], account: null },
      })),
    });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await waitFor(() => expect(b.preflight).toHaveBeenCalled());
    expect(screen.queryByText("You've hit your free-tier limit")).toBeNull();
  });

  it("Cancel is disabled while a create request is pending", async () => {
    let release!: (r: ApiResult<WorkspaceInfo>) => void;
    const b = bridge({
      createLocalWorkspace: vi.fn(() => new Promise<ApiResult<WorkspaceInfo>>((r) => (release = r))),
    });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await waitFor(() => expect(b.preflight).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText("my-workspace"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Create workspace"));
    await screen.findByText("Creating…");
    expect((screen.getByText("Cancel") as HTMLButtonElement).disabled).toBe(true);
    release({ ok: true, data: ws({ name: "x" }) });
  });
});

describe("guided create", () => {
  async function openWizard(b: ReturnType<typeof bridge>) {
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await waitFor(() => expect(b.preflight).toHaveBeenCalled());
  }

  it("opens straight on the name step: no Dependencies step, no install UI, no engine wording", async () => {
    const b = bridge();
    await openWizard(b);
    await screen.findByLabelText("Workspace name");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Dependenc|Step 1|Step 2|podman|install/i);
    expect(screen.queryByTestId("deps")).toBeNull();
    expect(screen.queryByTestId("deps-continue")).toBeNull();
    expect(screen.queryByTestId("preflight-blocked")).toBeNull();
  });

  it("a failed preflight shows its plain message and blocks Create", async () => {
    const b = bridge({ preflight: vi.fn(async (): Promise<PreflightResult> => ({ ok: false, code: "low_disk", message: "Not enough free disk space. Free up 4 GB and try again." })) });
    await openWizard(b);
    expect((await screen.findByTestId("preflight-blocked")).textContent).toBe("Not enough free disk space. Free up 4 GB and try again.");
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "box" } });
    expect((screen.getByText("Create workspace") as HTMLButtonElement).disabled).toBe(true);
    expect(b.createLocalWorkspace).not.toHaveBeenCalled();
  });

  it("Check again re-runs the preflight and enables Create without losing the typed name", async () => {
    const pre = vi.fn(async (): Promise<PreflightResult> => ({ ok: false, code: "low_disk", message: "Not enough free disk space. Free up 4 GB and try again." }));
    const b = bridge({ preflight: pre });
    await openWizard(b);
    await screen.findByTestId("preflight-blocked");
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "keepme" } });
    pre.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByTestId("preflight-recheck"));
    await waitFor(() => expect(screen.queryByTestId("preflight-blocked")).toBeNull());
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("keepme");
    expect((screen.getByText("Create workspace") as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates a local workspace through the bridge with the typed name", async () => {
    const b = bridge();
    await openWizard(b);
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "  box1 " } });
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(b.createLocalWorkspace).toHaveBeenCalledWith("box1"));
    // closes and reloads the list
    await waitFor(() => expect(b.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it.each(["plan_limit_local_workspaces", "plan_limit_workspaces"])("a 402 %s shows the limit modal", async (code) => {
    const b = bridge({
      createLocalWorkspace: vi.fn(async () => ({ ok: false, status: 402, code, limit: 2, error: "cap" })),
    });
    await openWizard(b);
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "box3" } });
    fireEvent.click(screen.getByText("Create workspace"));
    await screen.findByText("You've hit your free-tier limit");
  });
});

describe("Picker open failure", () => {
  afterEach(() => cleanup());

  it("shows the error with a Retry that re-opens the same workspace", async () => {
    const b = bridge();
    (window as unknown as { aw: unknown }).aw = b;
    const failed: AuthState = { ...state, openError: { slug: "acme", message: "Failed to set cookie" } };
    render(<Picker state={failed} />);
    expect(screen.getByTestId("open-error").textContent).toContain("Failed to set cookie");
    fireEvent.click(screen.getByTestId("open-retry"));
    expect(b.pickWorkspace).toHaveBeenCalledWith("acme");
  });

  it("shows a storage warning when the Keychain save failed", () => {
    (window as unknown as { aw: unknown }).aw = bridge();
    render(<Picker state={{ ...state, storageWarning: "Could not save your session" }} />);
    expect(screen.getByTestId("storage-warning").textContent).toContain("Could not save");
  });
});

describe("Remove local workspace", () => {
  const two = [ws({ name: "a", display_name: "Alpha" }), ws({ name: "b", display_name: "Beta", status: "running" })];

  it("confirm names the workspace and says its data is deleted; Cancel removes nothing", async () => {
    const b = bridge({ workspaces: two });
    render(<Picker state={state} />);
    fireEvent.click(await screen.findByTestId("remove-a"));
    const modal = await screen.findByTestId("remove-modal");
    expect(modal.textContent).toContain("Alpha");
    expect(modal.textContent).toMatch(/deletes the workspace/);
    expect(modal.textContent).toMatch(/all of its data/);
    expect(modal.textContent).not.toMatch(/sandbox/i);
    fireEvent.click(screen.getByTestId("remove-cancel"));
    expect(screen.queryByTestId("remove-modal")).toBeNull();
    expect(b.removeLocalWorkspace).not.toHaveBeenCalled();
  });

  it("confirming calls the bridge with the id, disables while busy, then the badge drops 2/2 -> 1/2 without restart", async () => {
    let release!: (r: ApiResult<null>) => void;
    let list = two;
    const b = bridge({
      workspaces: two,
      removeLocalWorkspace: vi.fn(() => new Promise<ApiResult<null>>((r) => (release = r))),
    });
    b.listWorkspaces.mockImplementation(async () => ({
      ok: true,
      data: { workspaces: list, account: { limits: { max_local_workspaces: 2 }, local_count: list.length } },
    }));
    render(<Picker state={state} />);
    expect((await screen.findByTestId("local-badge")).textContent).toBe("2/2");
    fireEvent.click(screen.getByTestId("remove-a"));
    fireEvent.click(await screen.findByTestId("remove-confirm"));
    expect(b.removeLocalWorkspace).toHaveBeenCalledWith("a");
    expect((screen.getByTestId("remove-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("remove-cancel") as HTMLButtonElement).disabled).toBe(true);
    list = [two[1]!];
    release({ ok: true, data: null });
    await waitFor(() => expect(screen.queryByTestId("remove-modal")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("local-badge").textContent).toBe("1/2"));
    expect(screen.queryByTestId("remove-a")).toBeNull();
  });

  it("a failure is shown with a Retry that tries again", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "podman busy" })
      .mockResolvedValueOnce({ ok: true, data: null });
    bridge({ workspaces: two, removeLocalWorkspace: fn });
    render(<Picker state={state} />);
    fireEvent.click(await screen.findByTestId("remove-a"));
    fireEvent.click(await screen.findByTestId("remove-confirm"));
    expect((await screen.findByTestId("remove-error")).textContent).toContain("podman busy");
    const retry = screen.getByTestId("remove-confirm") as HTMLButtonElement;
    expect(retry.textContent).toBe("Retry");
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("remove-modal")).toBeNull());
  });

  it("a stopped (half-created / failed) workspace has Remove too, and the limit modal leads to it", async () => {
    bridge({ workspaces: two });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    expect(screen.getByTestId("pending-a").querySelector("[data-remove]")).not.toBeNull();
    fireEvent.click(local.querySelector(":scope > button")!);
    await screen.findByText("You've hit your free-tier limit");
    fireEvent.click(screen.getByTestId("limit-remove"));
    expect(screen.queryByText("You've hit your free-tier limit")).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("remove-a");
  });
});
