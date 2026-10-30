import { describe, expect, it } from "vitest";
import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import { rightColumnPlacement } from "@/plugins/right-column";
import { autoOpenTargets } from "@/plugins/workspace-panels/auto-open";

const agentId = "f5627d30-26e6-4fbf-9fea-441cabb502a7";

describe("rightColumnPlacement", () => {
  it("欄が無い(狭い画面・作れなかった)ときは置き場所を指定しない", () => {
    expect(rightColumnPlacement(null, "front")).toBeUndefined();
  });

  it("ボタンで開いたときは前へ出す(既存タブもその欄へ移す)", () => {
    expect(rightColumnPlacement("p1", "front")).toEqual({ mode: "pane", paneId: "p1" });
  });

  it("自動で入れたときは後ろへ足す(ユーザーが置いた物を隠さない)", () => {
    expect(rightColumnPlacement("p1", "behind")).toEqual({ mode: "prefer", paneId: "p1" });
  });
});

describe("autoOpenTargets", () => {
  const plugin = (
    id: string,
    panels: {
      id: string;
      context?: "workspace" | "agent";
      locations?: ("workspace" | "explorer" | "right")[];
      whenAgentIds?: string[];
    }[],
  ) => ({
    id,
    serverId: "srv",
    workspacePanels: panels.map(
      (panel): PluginWorkspacePanelContribution => ({
        id: panel.id,
        title: panel.id,
        icon: "ListChecks",
        context: panel.context ?? "workspace",
        locations: panel.locations ?? ["workspace", "right"],
        Component: () => null,
        ...(panel.whenAgentIds ? { autoOpen: { whenAgentIds: panel.whenAgentIds } } : {}),
      }),
    ),
  });

  it("窓口Bのスレなら、自動で出す面だけを返す", () => {
    expect(
      autoOpenTargets(
        [
          plugin("topos-confirm-box", [
            { id: "windowb", whenAgentIds: [agentId] },
            { id: "other" },
          ]),
        ],
        "srv",
        agentId,
      ),
    ).toEqual([{ pluginId: "topos-confirm-box", panelId: "windowb" }]);
  });

  it("別のスレでは出さない(窓口B以外には出さない)", () => {
    expect(
      autoOpenTargets(
        [plugin("topos-confirm-box", [{ id: "windowb", whenAgentIds: [agentId] }])],
        "srv",
        "another-agent",
      ),
    ).toEqual([]);
    expect(
      autoOpenTargets(
        [plugin("topos-confirm-box", [{ id: "windowb", whenAgentIds: [agentId] }])],
        "srv",
        null,
      ),
    ).toEqual([]);
  });

  it("別のホスト・右カラムに置けない面・スレ紐付きの面は対象外", () => {
    const panels = [
      {
        id: "no-right",
        locations: ["workspace"] as ("workspace" | "right")[],
        whenAgentIds: [agentId],
      },
      { id: "agent-panel", context: "agent" as const, whenAgentIds: [agentId] },
      { id: "ok", whenAgentIds: [agentId] },
    ];
    expect(autoOpenTargets([plugin("p", panels)], "srv", agentId)).toEqual([
      { pluginId: "p", panelId: "ok" },
    ]);
    expect(
      autoOpenTargets([{ ...plugin("p", panels), serverId: "other" }], "srv", agentId),
    ).toEqual([]);
  });
});
