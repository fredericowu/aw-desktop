// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Picker } from "../src/renderer/screens/Picker";
import type { ApiResult, AuthState, AwBridge, RuntimeCheck, WorkspaceInfo, WorkspaceListData } from "../src/shared/types";

const state: AuthState = { stage: "picker", user: null, error: null, apex: "aw.tekflox.com" };
const ws = (over: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  name: "w",
  placement_driver: "remote-host",
  is_hosted: false,
  status: "provisioning",
  ...over,
});
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
    await screen.findByText("Not found");
    expect(screen.getByText("Download Docker Desktop ↗")).toBeTruthy();
    expect(screen.getByText("Download Podman ↗")).toBeTruthy();
    expect((screen.getByText("Continue") as HTMLButtonElement).disabled).toBe(true);

    b.checkRuntime.mockResolvedValueOnce(found);
    fireEvent.click(screen.getByText("I've installed it — Re-check"));
    await screen.findByText("Found");
    expect(b.checkRuntime).toHaveBeenCalledTimes(2);
    expect((screen.getByText("Continue") as HTMLButtonElement).disabled).toBe(false);
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
