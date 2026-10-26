/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPLORER_SIDEBAR_PANE_ID } from "@/stores/workspace-layout-actions";
import {
  createWorkspaceLayoutStore,
  createWorkspaceLayoutWithExplorerSidebar,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { openAgentInRightColumn, planOpenAgentInRightColumn } from "./open-agent-right";

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));

const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);
const SERVER_ID = "host-1";
const WORKSPACE_ID = "ws-main";
const WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;
const DEFAULT_PANE_ID = "main";

function createLayoutStore() {
  let index = 0;
  return createWorkspaceLayoutStore({
    createNodeId: (prefix: "pane" | "group") => `${prefix}_t${++index}`,
    createFocusRestorationToken: () => `token-${++index}`,
  });
}

const layoutStore = createLayoutStore();

/** サイドペイン(右カラム)に既存のスレを1つ開いておく。 */
function layoutWithSidePane(): string {
  layoutStore.setState({ layoutByWorkspace: {}, explorerSidebarPaneIdByWorkspace: {} });
  const paneId = layoutStore.getState().ensureSidePane(WORKSPACE_KEY);
  if (!paneId) throw new Error("サイドペインを作れなかった");
  layoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "existing-agent" },
    intent: "reveal",
    placement: { mode: "pane", paneId },
  });
  return paneId;
}

function baseDeps(overrides: Partial<Parameters<typeof planOpenAgentInRightColumn>[1]> = {}) {
  return {
    readAgentWorkspaceId: () => WORKSPACE_ID,
    resolveWorkspaceMapKey: ({ workspaceId }: { workspaceId: string }) => workspaceId,
    readLayout: (_key: string): WorkspaceLayout | null => null,
    readExplorerSidebarPaneId: () => null,
    readSidePaneId: () => null,
    ...overrides,
  };
}

describe("planOpenAgentInRightColumn", () => {
  it("エージェントのワークスペースがわからなければ開かない", () => {
    const reasons: string[] = [];
    expect(
      planOpenAgentInRightColumn(
        { serverId: SERVER_ID, agentId: "a" },
        baseDeps({
          readAgentWorkspaceId: () => null,
          reportUnavailable: (reason) => reasons.push(reason),
        }),
      ),
    ).toBeNull();
    expect(reasons).toEqual(["agent-workspace-unknown"]);
  });

  it("ワークスペース一覧に無くても、生のIDで置き場所を決める", () => {
    // 2026-10-27 本番: 一覧から引けないだけで右カラムを諦めていた(押しても遷移するだけだった)。
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({ resolveWorkspaceMapKey: () => null }),
    );
    expect(plan).toEqual({
      workspaceId: WORKSPACE_ID,
      workspaceKey: WORKSPACE_KEY,
      paneId: null,
    });
  });

  it("保存済みレイアウトが無ければ、呼び出し側が右カラムを作る(paneId: null)", () => {
    expect(planOpenAgentInRightColumn({ serverId: SERVER_ID, agentId: "a" }, baseDeps())).toEqual({
      workspaceId: WORKSPACE_ID,
      workspaceKey: WORKSPACE_KEY,
      paneId: null,
    });
  });

  it("スレが左で開いていても右カラムのサイドペインに開く", () => {
    layoutStore.setState({ layoutByWorkspace: {}, explorerSidebarPaneIdByWorkspace: {} });
    const mainPaneId = layoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const sidePaneId = layoutStore.getState().ensureSidePane(WORKSPACE_KEY);
    expect(mainPaneId).not.toBeNull();
    expect(sidePaneId).not.toBeNull();

    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "agent-1" },
      baseDeps({
        readLayout: (key) => layoutStore.getState().layoutByWorkspace[key] ?? null,
        readSidePaneId: (key) => layoutStore.getState().sidePaneIdByWorkspace[key],
      }),
    );
    expect(plan?.paneId).toBe(sidePaneId);
  });

  it("そのスレがすでにサイドペインで開いていれば、そのペインをそのまま使う", () => {
    layoutStore.setState({ layoutByWorkspace: {}, explorerSidebarPaneIdByWorkspace: {} });
    const sidePaneId = layoutStore.getState().ensureSidePane(WORKSPACE_KEY) as string;
    layoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      placement: { mode: "pane", paneId: sidePaneId },
    });
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "agent-1" },
      baseDeps({
        readLayout: (key) => layoutStore.getState().layoutByWorkspace[key] ?? null,
        readSidePaneId: (key) => layoutStore.getState().sidePaneIdByWorkspace[key],
      }),
    );
    expect(plan?.paneId).toBe(sidePaneId);
  });

  it("サイドペインの記録が古ければ、一番右の(エクスプローラ以外の)ペインに開く", () => {
    layoutStore.setState({ layoutByWorkspace: {}, explorerSidebarPaneIdByWorkspace: {} });
    const mainPaneId = layoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    }) as string;
    const rightmostPaneId = layoutStore.getState().ensureSidePane(WORKSPACE_KEY) as string;
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({
        readLayout: (key) => layoutStore.getState().layoutByWorkspace[key] ?? null,
        readExplorerSidebarPaneId: () => EXPLORER_SIDEBAR_PANE_ID,
        readSidePaneId: () => "stale-pane",
      }),
    );
    expect(plan?.paneId).not.toBe(mainPaneId);
    expect(rightmostPaneId).toBeTruthy();
    expect(plan?.paneId).toBe(rightmostPaneId);
    expect(plan?.paneId).not.toBe(EXPLORER_SIDEBAR_PANE_ID);
  });

  it("エクスプローラを表示していても、エクスプローラを右カラムと間違えない", () => {
    const layout = createWorkspaceLayoutWithExplorerSidebar();
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({
        readLayout: () => layout,
        readExplorerSidebarPaneId: () => null,
      }),
    );
    expect(plan?.paneId).toBeNull();
    expect(plan?.paneId).not.toBe(EXPLORER_SIDEBAR_PANE_ID);
  });

  it("上下分割だけなら右カラムは無い(paneId: null)", () => {
    const upper = { kind: "pane" as const, pane: { id: DEFAULT_PANE_ID, tabIds: [], focusedTabId: null } };
    const lower = { kind: "pane" as const, pane: { id: "lower", tabIds: [], focusedTabId: null } };
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: { id: "top", direction: "vertical", children: [upper, lower], sizes: [0.5, 0.5] },
      },
      focusedPaneId: DEFAULT_PANE_ID,
    };
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({ readLayout: () => layout }),
    );
    expect(plan?.paneId).toBeNull();
  });

  it("右側が上下に積まれていても、左のペインへは戻らない(右側の先頭を使う)", () => {
    const pane = (id: string) => ({
      kind: "pane" as const,
      pane: { id, tabIds: [], focusedTabId: null },
    });
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "outer",
          direction: "horizontal",
          children: [
            pane("left"),
            {
              kind: "group",
              group: {
                id: "right-stack",
                direction: "vertical",
                children: [pane("right-top"), pane("right-bottom")],
                sizes: [0.5, 0.5],
              },
            },
          ],
          sizes: [0.5, 0.5],
        },
      },
      focusedPaneId: "left",
    };
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({ readLayout: () => layout }),
    );
    expect(plan?.paneId).toBe("right-top");
    expect(plan?.paneId).not.toBe("left");
  });

  it("隠れたサイドペインの記録は使い回さない", () => {
    const pane = (id: string, hidden?: boolean) => ({
      kind: "pane" as const,
      pane: { id, tabIds: [], focusedTabId: null, ...(hidden ? { hidden } : {}) },
    });
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "outer",
          direction: "horizontal",
          children: [pane("left"), pane("old-side", true), pane("right")],
          sizes: [0.4, 0.2, 0.4],
        },
      },
      focusedPaneId: "left",
    };
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({ readLayout: () => layout, readSidePaneId: () => "old-side" }),
    );
    expect(plan?.paneId).toBe("right");
  });

  it("右側が同じ向きの横分割で入れ子になっていても、いちばん右を選ぶ", () => {
    const pane = (id: string) => ({
      kind: "pane" as const,
      pane: { id, tabIds: [], focusedTabId: null },
    });
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "outer",
          direction: "horizontal",
          children: [
            pane("left"),
            {
              kind: "group",
              group: {
                id: "inner",
                direction: "horizontal",
                children: [pane("mid"), pane("far-right")],
                sizes: [0.5, 0.5],
              },
            },
          ],
          sizes: [0.3, 0.7],
        },
      },
      focusedPaneId: "left",
    };
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({ readLayout: () => layout }),
    );
    expect(plan?.paneId).toBe("far-right");
  });

  it("右側が全部隠れていれば、左のペインへは開かず新しく右カラムを作らせる", () => {
    const pane = (id: string, hidden?: boolean) => ({
      kind: "pane" as const,
      pane: { id, tabIds: [], focusedTabId: null, ...(hidden ? { hidden } : {}) },
    });
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "outer",
          direction: "horizontal",
          children: [pane("left"), pane("old-side", true)],
          sizes: [0.8, 0.2],
        },
      },
      focusedPaneId: "left",
    };
    const plan = planOpenAgentInRightColumn(
      { serverId: SERVER_ID, agentId: "a" },
      baseDeps({ readLayout: () => layout, readSidePaneId: () => "old-side" }),
    );
    expect(plan?.paneId).toBeNull();
    expect(plan?.paneId).not.toBe("left");
  });
});

describe("openAgentInRightColumn", () => {
  const initialSessionState = useSessionStore.getState();
  let initialLayoutState: ReturnType<typeof layoutStore.getState>;

  // 実装はアプリのストア(useWorkspaceLayoutStore)を持つ。テストはそのストアに状態を置き、
  // 変更をこのテスト用ストアへも写して確かめる(差し替えではなく観測)。
  beforeEach(() => {
    navigateToWorkspaceMock.mockReset();
    initialLayoutState ??= useWorkspaceLayoutStore.getState();
    vi.spyOn(useWorkspaceLayoutStore, "getState").mockImplementation(() => layoutStore.getState());
    vi.spyOn(useWorkspaceLayoutStore, "setState").mockImplementation(layoutStore.setState as never);
    layoutStore.setState({
      layoutByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
    });
    useSessionStore.setState({
      sessions: {
        [SERVER_ID]: {
          ...initialSessionState.sessions[SERVER_ID],
          agents: new Map([["agent-1", { id: "agent-1", workspaceId: WORKSPACE_ID }]]),
          agentDetails: new Map(),
          workspaces: new Map([[WORKSPACE_ID, { id: WORKSPACE_ID, projectId: "p" }]]),
        },
      } as never,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({ sessions: initialSessionState.sessions });
    useWorkspaceLayoutStore.setState(initialLayoutState);
  });

  it("PC幅の「スレを開く」はサイドペインにエージェントを置く", () => {
    const paneId = layoutWithSidePane();
    expect(openAgentInRightColumn({ serverId: SERVER_ID, agentId: "agent-1" })).toBe(true);
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: "agent-1" },
      placement: { mode: "pane", paneId },
    });
  });

  it("保存済みレイアウトの読み込み前は false を返し、右カラムを勝手に作らない", () => {
    vi.spyOn(useWorkspaceLayoutStore.persist, "hasHydrated").mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(openAgentInRightColumn({ serverId: SERVER_ID, agentId: "agent-1" })).toBe(false);
    expect(layoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeUndefined();
    expect(navigateToWorkspaceMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join("\n")).toContain("Right column unavailable: layout-not-loaded");
    warn.mockRestore();
  });

  it("サイドペインを作れなければ、理由を記録して false を返す", () => {
    vi.spyOn(useWorkspaceLayoutStore.getState(), "ensureSidePane").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(openAgentInRightColumn({ serverId: SERVER_ID, agentId: "agent-1" })).toBe(false);
    expect(warn.mock.calls.flat().join("\n")).toContain("Right column unavailable: side-pane-unavailable");
    warn.mockRestore();
  });

  it("エージェントが見つからなければ false を返し、呼び出し側が通常遷移へ落とせる", () => {
    layoutWithSidePane();
    expect(openAgentInRightColumn({ serverId: SERVER_ID, agentId: "missing" })).toBe(false);
    expect(navigateToWorkspaceMock).not.toHaveBeenCalled();
  });

  it("サイドペインの無いワークスペースでは右カラムを作ってから開く", () => {
    expect(openAgentInRightColumn({ serverId: SERVER_ID, agentId: "agent-1" })).toBe(true);
    const sidePaneId = layoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY];
    expect(sidePaneId).toBeTruthy();
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ placement: { mode: "pane", paneId: sidePaneId } }),
    );
  });

});
