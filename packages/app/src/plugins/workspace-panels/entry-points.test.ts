import { describe, expect, it } from "vitest";
import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import {
  bandTargets,
  edgeSwipeTargets,
  entryOpenLocation,
  resolveEdgeSwipe,
} from "@/plugins/workspace-panels/entry-points";

const windowB = "29f7ab97-3c33-407e-8a2b-c5284dd38f99";
const other = "f5627d30-26e6-4fbf-9fea-441cabb502a7";
const Band = () => null;

function plugin(
  serverId: string,
  panel: Partial<PluginWorkspacePanelContribution> & { id: string },
) {
  return {
    id: "p",
    serverId,
    workspacePanels: [
      {
        title: panel.id,
        icon: "ListChecks",
        context: "workspace",
        locations: ["workspace", "right"],
        Component: () => null,
        ...panel,
      } as PluginWorkspacePanelContribution,
    ],
  };
}

describe("resolveEdgeSwipe(2026-10-30 窓口Bの右端スワイプ)", () => {
  it("左向きに14px以上で横が優勢なら開く", () => {
    expect(resolveEdgeSwipe(-14, 0)).toBe("open");
    expect(resolveEdgeSwipe(-30, 20)).toBe("open"); // 30 >= 1.25 * 20
  });

  it("横が縦の1.25倍に満たない斜めは開かず、縦が優勢と分かればキャンセルする", () => {
    expect(resolveEdgeSwipe(-20, 20)).toBe("pending"); // 縦もまだ14px以上だが横=縦(縦が優勢ではない)
    expect(resolveEdgeSwipe(-14, 20)).toBe("cancel");
  });

  it("タップ(ほぼ動かない)と小さな動きは保留、右向きはキャンセル", () => {
    expect(resolveEdgeSwipe(0, 0)).toBe("pending");
    expect(resolveEdgeSwipe(-13, 2)).toBe("pending");
    expect(resolveEdgeSwipe(20, 0)).toBe("cancel");
  });
});

describe("edgeSwipeTargets / bandTargets", () => {
  it("edgeSwipe:true の面を、そのスレのときだけ返す", () => {
    const plugins = [
      plugin("srv", { id: "w", autoOpen: { whenAgentIds: [windowB], edgeSwipe: true } }),
    ];
    expect(edgeSwipeTargets(plugins, "srv", windowB)).toEqual([{ pluginId: "p", panelId: "w" }]);
    expect(edgeSwipeTargets(plugins, "srv", other)).toEqual([]);
    expect(edgeSwipeTargets(plugins, "srv", null)).toEqual([]);
    expect(edgeSwipeTargets(plugins, "other-srv", windowB)).toEqual([]);
  });

  it("edgeSwipe を付けない autoOpen は対象外", () => {
    const plugins = [plugin("srv", { id: "w", autoOpen: { whenAgentIds: [windowB] } })];
    expect(edgeSwipeTargets(plugins, "srv", windowB)).toEqual([]);
  });

  it("band はそのスレのときだけ返す", () => {
    const plugins = [
      plugin("srv", { id: "w", band: { whenAgentIds: [windowB], Component: Band } }),
    ];
    expect(bandTargets(plugins, "srv", windowB)).toEqual([
      { pluginId: "p", panelId: "w", Component: Band },
    ]);
    expect(bandTargets(plugins, "srv", other)).toEqual([]);
    expect(bandTargets(plugins, "srv", null)).toEqual([]);
  });
});

describe("entryOpenLocation", () => {
  const panel = plugin("srv", { id: "w" }).workspacePanels[0];
  it("広い画面は右カラム、狭い画面は主ペイン", () => {
    expect(entryOpenLocation(panel, 1000, 720)).toBe("right");
    expect(entryOpenLocation(panel, 390, 720)).toBe("workspace");
  });
  it("右に置けない面は広くても主ペイン", () => {
    const p = plugin("srv", { id: "w", locations: ["workspace"] }).workspacePanels[0];
    expect(entryOpenLocation(p, 1000, 720)).toBe("workspace");
  });
});
