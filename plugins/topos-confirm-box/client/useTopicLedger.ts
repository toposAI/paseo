/**
 * 右ペインの「話題単位」表示。司令塔(ハブ)宛のとき、相手スレのライブ会話ではなく、
 * 箱の台帳にあるこのカードの質問と、上位スレが `say` で返した返事だけを出す。
 * 送信前に台帳へ質問を1行書き、返信IDを得る(送る文へ埋める)。
 */
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { cardChatAskRpc, cardChatListRpc, coordinatorTargetRpc } from "../shared/contract.js";
import type { CardChatListOutput, ConfirmBoxItem } from "../shared/contract.js";
import { isHubTarget, pendingReplyAgeS } from "../shared/card-pane.js";

/** 台帳(箱のイベント列)を読み直す間隔。 */
const LEDGER_MS = 4_000;

export interface TopicLine {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function useTopicLedger(input: {
  item: ConfirmBoxItem | null;
  sendAgentId: string | null;
  fallback: boolean;
}) {
  const { item, sendAgentId, fallback } = input;
  const coordinatorRpc = useRpc(coordinatorTargetRpc);
  const askRpc = useRpc(cardChatAskRpc);
  const listRpc = useRpc(cardChatListRpc);
  const [hubIds, setHubIds] = useState<string[]>([]);
  const [scopeAll, setScopeAll] = useState(false);
  const [ledger, setLedger] = useState<CardChatListOutput["messages"]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const itemId = item?.id ?? null;
  const itemKey = item?.key ?? null;

  const hub = item !== null && (fallback || isHubTarget(sendAgentId, hubIds));
  const topicMode = hub && !scopeAll;

  // 司令塔の一覧(ハブ判定用)。1回だけ引く。引けなければ空のまま=従来のライブ表示。
  useEffect(() => {
    let alive = true;
    void coordinatorRpc({})
      .then((res) => (alive ? setHubIds(res.hubIds ?? []) : undefined))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [coordinatorRpc]);

  const reload = useCallback(async () => {
    if (!itemId) return;
    try {
      const res = await listRpc({ id: itemId, key: itemKey });
      setLedger(res.messages);
      setNowMs(Date.now());
    } catch {
      // 読めない回は前の表示を保つ。
    }
  }, [listRpc, itemId, itemKey]);

  useEffect(() => {
    setLedger([]);
    if (!topicMode) return undefined;
    void reload();
    const timer = setInterval(() => void reload(), LEDGER_MS);
    return () => clearInterval(timer);
  }, [topicMode, reload]);
  useEffect(() => setScopeAll(false), [itemId]);

  const toggleScope = useCallback(() => setScopeAll((v) => !v), []);

  /** 台帳に質問を1行書いて返信IDを返す。書けなければ null(送信は従来の見出しだけで続ける)。 */
  const ask = useCallback(
    async (text: string): Promise<string | null> => {
      if (!hub || !itemId) return null;
      const res = await askRpc({ id: itemId, key: itemKey, text }).catch(() => null);
      void reload();
      return res?.ok ? res.replyId : null;
    },
    [hub, itemId, itemKey, askRpc, reload],
  );

  const shown: TopicLine[] = ledger.map((m, i) => ({
    id: `l${i}`,
    role: m.role === "user" ? "user" : "assistant",
    text: m.text,
  }));
  const pendingAge = topicMode ? pendingReplyAgeS(ledger, nowMs) : null;
  return { hub, topicMode, toggleScope, shown, pendingAge, ask };
}
