/**
 * 確認箱のペイン(カードの投函元スレ / 優先順位の担当スレ)の状態をまとめる。
 *
 * ペインの相手は URL(`?card=` / `?thread=`)が正で、ここでは「その相手が誰か」と
 * 「開く操作」だけを持つ。ConfirmBoxView の分岐を増やさないために切り出した
 * (2026-10-23、lint の complexity 上限に当たったため)。
 */
import { useCallback, useMemo, useState } from "react";
import type { ConfirmBoxItem } from "../shared/contract.js";
import type { PaneTarget } from "../shared/card-pane.js";

export interface ConfirmBoxPaneState {
  /** 開いているカードの id(無ければ null)。 */
  paneCardId: string | null;
  /** 開いているスレの agent id(無ければ null)。 */
  paneThreadId: string | null;
  /** paneCardId に対応する一覧の項目。まだ一覧に来ていない/消えた項目は null。 */
  paneItem: ConfirmBoxItem | null;
  /** 優先順位の行から開いた時の見出し(プロジェクト名)。 */
  paneThreadTitle: string | null;
  /** 担当スレが未設定の行を押した時の知らせ(黙って無反応にしない)。 */
  threadNotice: string | null;
  openCard: (item: ConfirmBoxItem) => void;
  /** 担当スレを開く。未設定(null)なら知らせだけ出して開かない。 */
  openThread: (agentId: string | null, name: string) => void;
}

export function useConfirmBoxPane({
  items,
  pane,
  openPane,
}: {
  items: ConfirmBoxItem[] | undefined;
  pane: PaneTarget | null;
  openPane: (target: PaneTarget) => void;
}): ConfirmBoxPaneState {
  const paneCardId = pane && pane.kind === "card" ? pane.id : null;
  const paneThreadId = pane && pane.kind === "thread" ? pane.id : null;
  const paneItem = useMemo(
    () => (paneCardId ? (items?.find((i) => i.id === paneCardId) ?? null) : null),
    [items, paneCardId],
  );
  const [paneThreadTitle, setPaneThreadTitle] = useState<string | null>(null);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);

  const openCard = useCallback(
    (item: ConfirmBoxItem) => openPane({ kind: "card", id: item.id }),
    [openPane],
  );
  const openThread = useCallback(
    (agentId: string | null, name: string) => {
      if (!agentId) {
        setThreadNotice(`「${name}」の担当スレが未設定です(台帳に thread が入っていません)`);
        return;
      }
      setThreadNotice(null);
      setPaneThreadTitle(name);
      openPane({ kind: "thread", id: agentId });
    },
    [openPane],
  );

  return {
    paneCardId,
    paneThreadId,
    paneItem,
    paneThreadTitle,
    threadNotice,
    openCard,
    openThread,
  };
}
