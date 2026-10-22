/**
 * 子スレ一覧の画面本体(サイドバーの行を押すと開く)。題名・状態・依頼、完了なら
 * 完了まとめ(5節の本文は確認箱の項目と同一)。選んだ子スレ(`focusId`)は先頭で展開する。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { childThreadsListRpc } from "../shared/child-threads.js";
import type { ChildThreadsListOutput } from "../shared/child-threads.js";

const REFRESH_MS = 30_000;

/** 見出し文。読み込み中/エラー/件数の3状態をここで畳む(JSX に入れ子の三項を書かない)。 */
function describe(error: string | null, data: ChildThreadsListOutput | null): string {
  if (error) return `取得できません: ${error}`;
  if (!data) return "読み込み中…";
  return `子スレ ${data.threads.length} 件`;
}

/**
 * 完了まとめの確認状態。**個別 ack** で判定する(アーカイブ条件と同じ定義)。
 * 状態が取れない/未完了なら何も出さない。
 */
function summaryNote(thread: {
  status: string;
  summaryItemId: string | null;
  summaryAcked: boolean;
}): string {
  if (thread.status !== "完了" || !thread.summaryItemId) return "";
  return thread.summaryAcked ? " ・ まとめ確認済み" : " ・ まとめ未確認";
}

export function ChildThreadsView({
  theme,
  focusId,
}: Pick<PluginHostProps, "theme"> & { focusId?: string | null }) {
  const list = useRpc(childThreadsListRpc);
  const [data, setData] = useState<ChildThreadsListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await list({}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const c = theme.colors;
  const s = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: 12, gap: 8 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      },
      title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
    }),
    [c],
  );

  return (
    <ScrollView style={s.root} contentContainerStyle={s.body}>
      <Text style={s.muted}>{describe(error, data)}</Text>
      {(data?.threads ?? [])
        .slice()
        .sort((a, b) => Number(b.agentId === focusId) - Number(a.agentId === focusId))
        .map((t) => (
          <View key={t.agentId} style={s.card}>
            <Text style={s.title}>{t.title}</Text>
            <Text style={s.muted}>
              {t.status}
              {t.machineState ? `(${t.machineState})` : ""}
              {summaryNote(t)}
            </Text>
            {t.request ? <Text style={s.text}>{t.request}</Text> : null}
            {t.status === "完了" ? (
              <Text style={s.text}>{t.summary ?? "(完了まとめを確認箱から引けません)"}</Text>
            ) : null}
          </View>
        ))}
    </ScrollView>
  );
}
