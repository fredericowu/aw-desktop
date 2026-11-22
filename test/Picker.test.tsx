// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Picker } from "../src/renderer/screens/Picker";
import type { DepId, DepsSnapshot, DepStatus } from "../src/shared/deps";
import type { ApiResult, AuthState, AwBridge, BootstrapProgress, RuntimeCheck, WorkspaceInfo, WorkspaceListData } from "../src/shared/types";

const state: AuthState = { stage: "picker", user: null, error: null, apex: "aw.tekflox.com" };
const ws = (over: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  name: "w",
  placement_driver: "desktop-local",
  is_hosted: false,
  status: "stopped",
  ...over,
});
let emitProgress: (p: BootstrapProgress) => void = () => undefined;
const none: RuntimeCheck = { runtimes: [], ready: false };
const item = (id: DepId, state: DepStatus["state"], extra: Partial<DepStatus> = {}): DepStatus => ({
  id, title: id, sub: "", required: id !== "machine", state,
  plan: state === "installed" ? undefined : { source: "https://x/" + id, size: "1.0 MB", checksum: "sha256 abc", dest: "~/x", needsAdmin: false },
  ...extra,
});
const snapOf = (_unused: DepStatus["state"], podman: DepStatus["state"], extra: Partial<DepsSnapshot> = {}): DepsSnapshot => ({
  platform: "darwin", supported: true,
  items: [item("podman", podman), item("machine", "missing", { plan: undefined })],
  ready: podman === "installed", ...extra,
});
const allReady = snapOf("installed", "installed");
const found: RuntimeCheck = { runtimes: [{ kind: "podman", installed: true, running: true }], ready: true };

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
    checkRuntime: vi.fn(async () => none),
    depsList: vi.fn(async () => snapOf("missing", "missing")),
    depsInstall: vi.fn(async () => ({ ok: true })),
    onDepsChanged: vi.fn(() => () => undefined),
    createLocalWorkspace: vi.fn(async (name: string): Promise<ApiResult<WorkspaceInfo>> => ({ ok: true, data: ws({ name }) })),
    pickWorkspace: vi.fn(async () => ({ ok: true })),
    finishLocalSetup: vi.fn(async () => ({ ok: true, data: null })),
    removeLocalWorkspace: vi.fn(async () => ({ ok: true, data: null })),
    getBootstrapProgress: vi.fn(async (): Promise<BootstrapProgress | null> => null),
    onBootstrapProgress: vi.fn((cb: (p: BootstrapProgress) => void) => {
      emitProgress = cb;
      return () => undefined;
    }),
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
    expect(b.depsList).not.toHaveBeenCalled();
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

  it("bootstrap failure shows the failing step and last log lines, with Retry", async () => {
    const b = bridge();
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    emitProgress({
      slug: "mine",
      phase: "failed",
      step: "image",
      done: ["machine"],
      failedStep: "image",
      error: "exited with code 1",
      lines: ["podman: FAILED", "machine init error"],
    });
    const err = await screen.findByTestId("bootstrap-error");
    expect(err.textContent).toContain("Download the workspace image");
    expect(screen.getByTestId("bootstrap-log").textContent).toContain("machine init error");
    expect(screen.getByTestId("step-image").getAttribute("data-state")).toBe("failed");
    fireEvent.click(screen.getByText("Retry"));
    expect(b.finishLocalSetup).toHaveBeenCalledWith("mine");
  });

  it("at the cap, Create shows the limit modal with no runtime check or create", async () => {
    const b = bridge({ workspaces: [ws({ name: "a" }), ws({ name: "b" })] });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await screen.findByText("You've hit your free-tier limit");
    expect(b.depsList).not.toHaveBeenCalled();
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
    await waitFor(() => expect(b.depsList).toHaveBeenCalled());
    expect(screen.queryByText("You've hit your free-tier limit")).toBeNull();
  });

  it("Cancel is disabled while a create request is pending", async () => {
    let release!: (r: ApiResult<WorkspaceInfo>) => void;
    const b = bridge({
      depsList: vi.fn(async () => allReady),
      createLocalWorkspace: vi.fn(() => new Promise<ApiResult<WorkspaceInfo>>((r) => (release = r))),
    });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await waitFor(() => expect(b.depsList).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("deps-continue"));
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
    await waitFor(() => expect(b.depsList).toHaveBeenCalled());
  }

  it("lists every dependency; nothing installs until the user clicks, and the plan is shown first", async () => {
    const b = bridge();
    await openWizard(b);
    await screen.findByTestId("dep-podman");
    const plan = screen.getByTestId("dep-podman-plan").textContent ?? "";
    expect(plan).toContain("https://x/podman");
    expect(plan).toContain("1.0 MB");
    expect(plan).toContain("sha256 abc");
    expect(b.depsInstall).not.toHaveBeenCalled();
    expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("dep-podman-install"));
    await waitFor(() => expect(b.depsInstall).toHaveBeenCalledWith("podman", true));
  });

  it("Re-check click reruns the probe immediately, independent of the poll timer", async () => {
    const b = bridge();
    await openWizard(b);
    await screen.findByTestId("dep-podman");
    await waitFor(() => expect((screen.getByTestId("deps-recheck") as HTMLButtonElement).disabled).toBe(false));
    const calls = b.depsList.mock.calls.length;
    b.depsList.mockResolvedValue(allReady);
    fireEvent.click(screen.getByTestId("deps-recheck"));
    await waitFor(() => expect(b.depsList.mock.calls.length).toBe(calls + 1));
    await waitFor(() => expect(screen.getByTestId("dep-podman").getAttribute("data-state")).toBe("installed"));
    expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(false);
  });

  it("flips missing -> installing -> installed on its own and only then enables Continue", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const b = bridge();
      await openWizard(b);
      await screen.findByTestId("dep-podman");
      expect(screen.getByTestId("dep-podman").getAttribute("data-state")).toBe("missing");
      b.depsList.mockResolvedValue(snapOf("installed", "installing", { items: [item("podman", "installing", { progress: 40 }), item("machine", "missing", { plan: undefined })] }));
      await vi.advanceTimersByTimeAsync(3100);
      await waitFor(() => expect(screen.getByTestId("dep-podman").getAttribute("data-state")).toBe("installing"));
      expect(screen.getByTestId("dep-podman-state").textContent).toContain("40%");
      b.depsList.mockResolvedValue(allReady);
      await vi.advanceTimersByTimeAsync(3100);
      await waitFor(() => expect(screen.getByTestId("dep-podman").getAttribute("data-state")).toBe("installed"));
      expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed install shows the error and a Retry; Continue stays disabled", async () => {
    const b = bridge({ depsList: vi.fn(async () => snapOf("installed", "failed", { items: [item("podman", "failed", { error: "checksum mismatch" }), item("machine", "missing", { plan: undefined })], ready: false })) });
    await openWizard(b);
    expect((await screen.findByTestId("dep-podman-error")).textContent).toContain("checksum mismatch");
    expect(screen.getByText("Retry")).toBeTruthy();
    expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an interrupted install is explained; an unsupported platform offers no install", async () => {
    const b = bridge({ depsList: vi.fn(async () => ({ ...snapOf("missing", "missing"), supported: false, platform: "win32", interrupted: "podman" as DepId, items: [item("podman", "missing", { plan: undefined })], ready: false })) });
    await openWizard(b);
    await screen.findByTestId("deps-interrupted");
    expect(screen.getByTestId("deps-unsupported").textContent).toContain("untested");
    expect(screen.queryByTestId("dep-podman-install")).toBeNull();
  });

  it("creates a local workspace through the bridge with the typed name", async () => {
    const b = bridge({ depsList: vi.fn(async () => allReady) });
    await openWizard(b);
    await waitFor(() => expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("deps-continue"));
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "  box1 " } });
    fireEvent.click(screen.getByText("Create workspace"));
    await waitFor(() => expect(b.createLocalWorkspace).toHaveBeenCalledWith("box1"));
    // closes and reloads the list
    await waitFor(() => expect(b.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it.each(["plan_limit_local_workspaces", "plan_limit_workspaces"])("a 402 %s shows the limit modal", async (code) => {
    const b = bridge({
      depsList: vi.fn(async () => allReady),
      createLocalWorkspace: vi.fn(async () => ({ ok: false, status: 402, code, limit: 2, error: "cap" })),
    });
    await openWizard(b);
    await waitFor(() => expect((screen.getByTestId("deps-continue") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("deps-continue"));
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
