/**
 * 優先順位を、小さな浮いた枠(ポップオーバー)ではなく**ワークスペースのパネル**として出す。
 *
 * 2026-11-02 ユーザー「優先度順位、PC版の時はチャット欄の右側のカラムに出るようにして。指示一覧が出てる時は
 * 上書きして、優先順位消したら指示一覧がまた出るようにして / iphone版は全画面でだして」。
 * - PC幅: 右カラムのタブとして前へ出す。指示一覧(`window-b-instructions`)が同じ欄に出ていれば、その上に重なり、
 *   優先順位を閉じると一覧がまた前に出る(欄に入れた物を前へ出す・閉じると下の物が出る、というホストの標準動作。
 *   `openPanel` の `focus` 既定=前へ出す)。一覧が出ていないときは欄に優先順位だけが入り、閉じても何も出さない。
 * - iPhone幅: 主ペイン=全画面。閉じると元の会話に戻る。
 * 中身は確認箱の「優先順位」タブそのもの(行タップの中身・並べ替え・アーカイブ・方針へ移す操作を共有する)。
 */
import { useCallback, useMemo, useState } from "react";
import { Dimensions, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { paneLocation } from "../shared/windowb-instructions.js";
import { ConfirmBoxView } from "./ConfirmBoxView.js";

export const PRIORITY_PANEL_ID = "priority-panel";
export const PRIORITY_PANEL_TITLE = "優先順位";

const fill = { flex: 1 };

/** 優先順位のパネルを開く。幅で置き場所を決める(PC=右カラム、狭い画面=全画面)。 */
export function openPriorityPanel(
  openPanel: (id: string, options: { location: "right" | "workspace" }) => void,
  onError?: () => void,
): boolean {
  try {
    openPanel(PRIORITY_PANEL_ID, { location: paneLocation(Dimensions.get("window").width) });
  } catch (e) {
    console.warn("[topos] priority panel was not opened", e);
    onError?.();
    return false;
  }
  return true;
}

/**
 * パネルの中身。右カラムは窓より狭いので、窓幅ではなく**箱の幅**を測って渡す
 * (窓幅で判定すると、一覧とチャットが狭い箱に横並びで押し込まれる)。
 */
export function PriorityPanel({
  theme,
  layout,
  navigation,
}: PluginHostProps & {
  navigation?: { openAgent: (input: { agentId: string; placement?: "right" }) => void };
}) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)),
    [],
  );
  const openAgent = useMemo(
    () =>
      navigation
        ? async (input: { agentId: string; placement?: "right" }) => {
            navigation.openAgent(input);
          }
        : undefined,
    [navigation],
  );
  return (
    <View style={fill} onLayout={onLayout}>
      <ConfirmBoxView
        theme={theme}
        layout={layout}
        containerWidth={width || undefined}
        mode="priority"
        openAgent={openAgent}
      />
    </View>
  );
}
