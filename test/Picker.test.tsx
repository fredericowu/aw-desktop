// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Picker } from "../src/renderer/screens/Picker";
import type { ApiResult, AuthState, AwBridge, BootstrapProgress, LocalHostStatus, RuntimeCheck, WorkspaceInfo, WorkspaceListData } from "../src/shared/types";

const state: AuthState = { stage: "picker", user: null, error: null, apex: "aw.tekflox.com" };
const ws = (over: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  name: "w",
  placement_driver: "remote-host",
  is_hosted: false,
  status: "provisioning",
  ...over,
});
let emitProgress: (p: BootstrapProgress) => void = () => undefined;
const none: RuntimeCheck = { runtimes: [], ready: false };
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
    createLocalWorkspace: vi.fn(async (name: string): Promise<ApiResult<WorkspaceInfo>> => ({ ok: true, data: ws({ name }) })),
    pickWorkspace: vi.fn(async () => ({ ok: true })),
    getLocalHost: vi.fn(async (): Promise<LocalHostStatus> => ({ binary: false, linked: false })),
    finishLocalSetup: vi.fn(async () => ({ ok: true, data: null })),
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
    expect(screen.getByText("No local sandboxes yet — create one to get started.")).toBeTruthy();
    expect(screen.getByText("No cloud sandboxes yet.")).toBeTruthy();
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
    expect(b.checkRuntime).not.toHaveBeenCalled();
  });

  it("a hosted membership shows under Cloud and opens normally", async () => {
    const b = bridge({ workspaces: [ws({ name: "acme", placement_driver: "remote-host", is_hosted: true, status: "running" })] });
    render(<Picker state={state} />);
    const cloud = await screen.findByTestId("cloud-block");
    fireEvent.click(cloud.querySelector(".workspace-list button")!);
    expect(b.pickWorkspace).toHaveBeenCalledWith("acme");
  });

  it("a created-but-unbootstrapped local row is 'Setup pending on this Mac' and not openable", async () => {
    const b = bridge({ workspaces: [ws({ name: "mine" })] });
    render(<Picker state={state} />);
    const row = await screen.findByTestId("pending-mine");
    expect(row.textContent).toContain("Setup pending on this Mac");
    expect(row.tagName).not.toBe("BUTTON");
    fireEvent.click(row);
    expect(b.pickWorkspace).not.toHaveBeenCalled();
  });

  it("a pending row offers Finish setup, which resumes by slug and never creates a row", async () => {
    const b = bridge({ workspaces: [ws({ name: "mine" })] });
    render(<Picker state={state} />);
    await screen.findByTestId("pending-mine");
    fireEvent.click(screen.getByText("Finish setup"));
    await waitFor(() => expect(b.finishLocalSetup).toHaveBeenCalledWith("mine"));
    expect(b.createLocalWorkspace).not.toHaveBeenCalled();
  });

  it("a pending row on a Mac that hosts another workspace is blocked, with no Finish setup", async () => {
    bridge({
      workspaces: [ws({ name: "mine" })],
      getLocalHost: vi.fn(async () => ({ binary: true, linked: true, workspaceSlug: "other" })),
    });
    render(<Picker state={state} />);
    const row = await screen.findByTestId("pending-mine");
    expect(row.textContent).toContain("already hosts another workspace");
    expect(screen.queryByText("Finish setup")).toBeNull();
  });

  it("marks the tile hosted on THIS Mac; other running local tiles read 'Runs on another machine'", async () => {
    bridge({
      workspaces: [ws({ name: "here", status: "running", remote_host_id: "rh_1" }), ws({ name: "away", status: "running" })],
      getLocalHost: vi.fn(async () => ({ binary: true, linked: true, workspaceSlug: "here", remoteHostId: "rh_1" })),
    });
    render(<Picker state={state} />);
    expect((await screen.findByTestId("here-here")).textContent).toContain("Runs on this Mac");
    expect(screen.getByTestId("remote-away").textContent).toContain("Runs on another machine");
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
      finishLocalSetup: vi.fn(async () => ({ ok: false, code: "already_linked", error: "This Mac already hosts a workspace." })),
    });
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    emitProgress({ slug: "mine", phase: "failed", step: "podman", done: [], failedStep: "podman", error: "boom", lines: [] });
    fireEvent.click(await screen.findByText("Retry"));
    const msg = await screen.findByTestId("retry-error");
    expect(msg.textContent).toContain("already hosts a workspace");
    expect(b.finishLocalSetup).toHaveBeenCalledWith("mine");
  });

  it("bootstrap failure shows the failing step and last log lines, with Retry", async () => {
    const b = bridge();
    render(<Picker state={state} />);
    await screen.findByTestId("local-block");
    emitProgress({
      slug: "mine",
      phase: "failed",
      step: "podman",
      done: ["cli", "token", "link"],
      failedStep: "podman",
      error: "exited with code 1",
      lines: ["podman: FAILED", "machine init error"],
    });
    const err = await screen.findByTestId("bootstrap-error");
    expect(err.textContent).toContain("Install Podman");
    expect(screen.getByTestId("bootstrap-log").textContent).toContain("machine init error");
    expect(screen.getByTestId("step-podman").getAttribute("data-state")).toBe("failed");
    fireEvent.click(screen.getByText("Retry"));
    expect(b.finishLocalSetup).toHaveBeenCalledWith("mine");
  });

  it("at the cap, Create shows the limit modal with no runtime check or create", async () => {
    const b = bridge({ workspaces: [ws({ name: "a" }), ws({ name: "b" })] });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await screen.findByText("You've hit your free-tier limit");
    expect(b.checkRuntime).not.toHaveBeenCalled();
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
    await waitFor(() => expect(b.checkRuntime).toHaveBeenCalled());
    expect(screen.queryByText("You've hit your free-tier limit")).toBeNull();
  });

  it("Cancel is disabled while a create request is pending", async () => {
    let release!: (r: ApiResult<WorkspaceInfo>) => void;
    const b = bridge({
      checkRuntime: vi.fn(async () => found),
      createLocalWorkspace: vi.fn(() => new Promise<ApiResult<WorkspaceInfo>>((r) => (release = r))),
    });
    render(<Picker state={state} />);
    const local = await screen.findByTestId("local-block");
    fireEvent.click(local.querySelector(":scope > button")!);
    await waitFor(() => expect(b.checkRuntime).toHaveBeenCalled());
    fireEvent.click(await screen.findByText("Continue"));
    fireEvent.change(screen.getByPlaceholderText("my-sandbox"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Create sandbox"));
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
    await waitFor(() => expect(b.checkRuntime).toHaveBeenCalled());
  }

  it("missing runtime shows install guidance and blocks Continue; Re-check does a real probe and flips to found", async () => {
    const b = bridge();
    await openWizard(b);
    await screen.findByText("Podman not ready");
    // Honest copy: Docker Desktop alone is not sufficient.
    expect(screen.getAllByText(/Podman command-line tool/).length).toBeGreaterThan(0);
    expect(screen.getByText("Download Docker Desktop ↗")).toBeTruthy();
    expect(screen.getByText("Download Podman ↗")).toBeTruthy();
    expect(screen.queryByText("Continue")).toBeNull();
    expect((screen.getByText("Install Podman for me") as HTMLButtonElement).disabled).toBe(false);

    b.checkRuntime.mockResolvedValueOnce(found);
    fireEvent.click(screen.getByText("I've installed it — Re-check"));
    await screen.findByText("Found");
    expect(b.checkRuntime).toHaveBeenCalledTimes(2);
    expect((screen.getByText("Continue") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Docker Desktop running without Podman is NOT treated as ready", async () => {
    const dockerOnly: RuntimeCheck = { runtimes: [{ kind: "docker-desktop", installed: true, running: true }], ready: true };
    const b = bridge({ checkRuntime: vi.fn(async () => dockerOnly) });
    await openWizard(b);
    await screen.findByText("Podman not ready");
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("'Install Podman for me' proceeds to the name step", async () => {
    const b = bridge();
    await openWizard(b);
    await screen.findByText("Podman not ready");
    fireEvent.click(screen.getByText("Install Podman for me"));
    await screen.findByLabelText("Sandbox name");
  });

  it("an already-linked Mac is blocked up front with the explanation", async () => {
    const b = bridge({ getLocalHost: vi.fn(async () => ({ binary: true, linked: true, workspaceSlug: "fredericowu" })) });
    await openWizard(b);
    const msg = await screen.findByTestId("already-linked");
    expect(msg.textContent).toContain("fredericowu");
    expect(screen.queryByText("Install Podman for me")).toBeNull();
    expect(b.createLocalWorkspace).not.toHaveBeenCalled();
  });

  it("an already_linked refusal from main shows the block, not a generic error", async () => {
    const b = bridge({
      checkRuntime: vi.fn(async () => found),
      createLocalWorkspace: vi.fn(async () => ({ ok: false, code: "already_linked", error: "This Mac already hosts a workspace." })),
    });
    await openWizard(b);
    await screen.findByText("Found");
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByLabelText("Sandbox name"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Create sandbox"));
    await screen.findByTestId("already-linked");
  });

  it("creates a remote-host workspace through the bridge with the typed name", async () => {
    const b = bridge({ checkRuntime: vi.fn(async () => found) });
    await openWizard(b);
    await screen.findByText("Found");
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByLabelText("Sandbox name"), { target: { value: "  box1 " } });
    fireEvent.click(screen.getByText("Create sandbox"));
    await waitFor(() => expect(b.createLocalWorkspace).toHaveBeenCalledWith("box1"));
    // closes and reloads the list
    await waitFor(() => expect(b.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it.each(["plan_limit_local_workspaces", "plan_limit_workspaces"])("a 402 %s shows the limit modal", async (code) => {
    const b = bridge({
      checkRuntime: vi.fn(async () => found),
      createLocalWorkspace: vi.fn(async () => ({ ok: false, status: 402, code, limit: 2, error: "cap" })),
    });
    await openWizard(b);
    await screen.findByText("Found");
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByLabelText("Sandbox name"), { target: { value: "box3" } });
    fireEvent.click(screen.getByText("Create sandbox"));
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
