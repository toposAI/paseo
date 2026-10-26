/**
 * 「子スレ完了」タブ。**既存の** `child_threads.json` / `childThreadsListRpc` をそのまま使い、
 * `isCardDone`(完了かつ `nocard` でない)の子スレと完了まとめ本文を並べる(新しい一覧を作らない)。
 * 完了まとめのカードを作らない運用(`nocard`)の行は箱に確認する項目が無いので出さない
 * (カードが無いので「完了にする」も「差し戻し」も出せない。差し戻しはスレ内で直接伝える)。
 *
 * 「完了にする」は完了まとめの箱項目を `ack(approve)` するだけ。ユーザーが子スレに直接「完了」と伝えた
 * 場合も同じ確認として扱われる(2026-10-23 ユーザー決定)。実際のアーカイブは既存の
 * `child_thread_registry.py tick`(4分毎)が ack 済みの完了スレを `paseo agent archive` する。
 * workspace は**子スレ専用の Paseo worktree の時だけ**畳む(司令塔の共有チェックアウトは他スレが
 * 隠れるため残す)。ここから削除経路を増やさない。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { childThreadsListRpc, childThreadsRevertRpc, isCardDone } from "../shared/child-threads.js";
import type { ChildThread, ChildThreadsListOutput } from "../shared/child-threads.js";
import { confirmBoxAckRpc, boxSignalRpc } from "../shared/contract.js";
import type { ToggleInfo } from "./HeaderIconBar.js";
import { notifyBoxChanged } from "./events.js";
import { watchBoxSignal } from "./change-signal.js";

const REFRESH_MS = 30_000;

/** `accessibilityState` は毎回新しいオブジェクトを渡さない(react-perf)。 */
const BTN_DISABLED = { disabled: true } as const;
const BTN_ENABLED = { disabled: false } as const;

/** 見出し文。読み込み中/エラー/件数の3状態をここで畳む(JSX に入れ子の三項を書かない)。 */
function describe(
  error: string | null,
  loaded: boolean,
  done: number,
  unconfirmed: number,
): string {
  if (error) return `取得できません: ${error}`;
  if (!loaded) return "読み込み中…";
  return `子スレ完了 ${done}件(確認待ち ${unconfirmed}件)`;
}

/** 確認ボタンの文言。 */
function confirmLabel(acked: boolean, busy: boolean): string {
  if (acked) return "確認済み";
  if (busy) return "確認中…";
  return "完了にする";
}

export function ChildDoneView({
  theme,
  navigation,
  showAcked = false,
  onToggleInfo,
}: Pick<PluginHostProps, "theme"> & {
  navigation?: { openAgent: (input: { agentId: string }) => void };
  /** 確認済みも出すか。切替ボタンは親(最上部のアイコン列)に置く。 */
  showAcked?: boolean;
  onToggleInfo?: (info: ToggleInfo | null) => void;
}) {
  const list = useRpc(childThreadsListRpc);
  const ack = useRpc(confirmBoxAckRpc);
  const signalTimes = useRpc(boxSignalRpc);
  const revertRpc = useRpc(childThreadsRevertRpc);
  // 差し戻した結果。カードは一覧から消えるので、結果の1行はここに残す(押し間違いに気づける。取り消しは無い)
  const [reverted, setReverted] = useState<{ agentId: string; title: string; message: string }[]>(
    [],
  );
  const [data, setData] = useState<ChildThreadsListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await list({}));
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    // 子スレの完了・取り下げ・再投函の合図で即取り直す(定期取得の30秒を待たない)。
    // box の合図(他の項目の投函・ack)には反応しない=重い一覧を無関係な変化で引かない(round6指摘6)。
    // 他端末の「完了にする」は ack で、サーバが child_threads でなく box の合図を書くので、
    // この端末は定期取得(30秒)で追いつく。
    const stop = watchBoxSignal(
      () => signalTimes({}),
      (which) => {
        if (which === "child_threads") void reload();
      },
    );
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [reload, signalTimes]);

  const c = theme.colors;
  const s = useMemo(
    () => ({
      root: { gap: 8 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      },
      title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      meta: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      warn: { color: c.statusWarning, fontSize: 12 },
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      // 見出しは左、更新ボタンは右上。長いエラー文でもボタンを押し出さない
      headText: { flex: 1, color: c.foregroundMuted, fontSize: 12 },
      chipNew: {
        color: c.accentForeground,
        fontSize: 11,
        fontWeight: "700" as const,
        backgroundColor: c.accent,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      chipDone: {
        color: c.foregroundMuted,
        fontSize: 11,
        fontWeight: "700" as const,
        backgroundColor: c.surface2,
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      btn: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
      },
      btnOff: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        opacity: 0.5,
      },
      btnText: { color: c.accentForeground, fontSize: 13 },
      btnTextOff: { color: c.foreground, fontSize: 13 },
    }),
    [c],
  );

  const done = useMemo(
    // 完了まとめのカードを作らない運用(`nocard`)の行は、箱に確認する項目が無いのでこのタブに出さない
    // (「完了にする」が押せない行・確認待ちの件数から外す)。
    () => (data?.threads ?? []).filter(isCardDone),
    [data],
  );
  // 「確認済み」は**個別の ack** で判定する(アーカイブ条件と同じ)。「すべて既読」ではアーカイブされないため。
  const isAcked = (t: ChildThread) => t.summaryAcked;
  const visible = showAcked ? done : done.filter((t) => !isAcked(t));
  const unconfirmed = done.filter((t) => !isAcked(t)).length;
  const header = describe(error, data !== null, done.length, unconfirmed);
  const hasDone = done.length > 0;
  useEffect(() => {
    if (!onToggleInfo) return undefined;
    onToggleInfo(
      hasDone
        ? {
            label: showAcked ? "確認済み隠す" : "確認済み表示",
            a11y: showAcked ? "確認済みを隠す" : "確認済みも表示",
          }
        : null,
    );
    return () => onToggleInfo(null);
  }, [onToggleInfo, hasDone, showAcked]);

  const confirm = useCallback(
    async (t: ChildThread) => {
      if (!t.summaryItemId) {
        setNotice("完了まとめが確認箱に無いため確認できません");
        return;
      }
      setBusy(t.agentId);
      try {
        const r = await ack({ id: t.summaryItemId, action: "approve" });
        setNotice(r.message);
        notifyBoxChanged();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
      void reload();
    },
    [ack, reload],
  );

  const revert = useCallback(
    async (t: ChildThread, instruction: string) => {
      setBusy(t.agentId);
      try {
        const r = await revertRpc({ agentId: t.agentId, instruction });
        setReverted((prev) => [
          { agentId: t.agentId, title: t.title, message: r.message },
          ...prev.filter((x) => x.agentId !== t.agentId),
        ]);
        notifyBoxChanged();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
      void reload();
    },
    [revertRpc, reload],
  );

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Text style={s.headText}>{header}</Text>
      </View>
      {notice ? <Text style={s.meta}>{notice}</Text> : null}
      {reverted.map((r) => (
        <View key={r.agentId} style={s.card} testID={`childdone-reverted-${r.agentId}`}>
          <Text style={s.title}>差し戻し: {r.title}</Text>
          <Text style={s.text}>{r.message}</Text>
          <Text style={s.meta}>
            子スレが [STATUS] 完了 か ユーザー判断待ち を宣言すると、カードが作り直されます。
          </Text>
        </View>
      ))}
      {data && visible.length === 0 && !error ? (
        <Text style={s.meta}>
          {done.length === 0 ? "完了した子スレはありません" : "確認待ちの完了報告はありません"}
        </Text>
      ) : null}
      {unconfirmed > 0 ? (
        <Text style={s.meta}>
          子スレに「完了」と伝えるか、下の「完了にする」を押すまで確認待ちです(勝手に畳みません)。
        </Text>
      ) : null}
      {visible.map((t) => (
        <DoneCard
          key={t.agentId}
          thread={t}
          styles={s}
          acked={isAcked(t)}
          busy={busy === t.agentId}
          onConfirm={confirm}
          onRevert={revert}
          navigation={navigation}
        />
      ))}
    </View>
  );
}

function DoneCard({
  thread,
  styles,
  acked,
  busy,
  onConfirm,
  onRevert,
  navigation,
}: {
  thread: ChildThread;
  styles: Record<string, object>;
  acked: boolean;
  busy: boolean;
  onConfirm: (t: ChildThread) => Promise<void>;
  onRevert: (t: ChildThread, instruction: string) => Promise<void>;
  navigation?: { openAgent: (input: { agentId: string }) => void };
}) {
  const confirm = useCallback(() => void onConfirm(thread), [onConfirm, thread]);
  const open = useCallback(
    () => navigation?.openAgent({ agentId: thread.agentId }),
    [navigation, thread.agentId],
  );
  const disabled = acked || busy || !thread.summaryItemId;
  // 追加指示はスレ側で出す運用なので入力欄は無し。押したらすぐ差し戻す。
  const submitRevert = useCallback(() => void onRevert(thread, ""), [onRevert, thread]);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={acked ? styles.chipDone : styles.chipNew}>
          {acked ? "確認済み" : "確認待ち"}
        </Text>
        <Text style={styles.meta}>{formatDate(thread.updatedAt)}</Text>
      </View>
      <Text style={styles.title}>{thread.title}</Text>
      {thread.parentTitle ? <Text style={styles.meta}>子司令塔: {thread.parentTitle}</Text> : null}
      <Text style={styles.text}>{thread.summary ?? "(完了まとめを確認箱から引けません)"}</Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={disabled ? BTN_DISABLED : BTN_ENABLED}
          style={disabled ? styles.btnOff : styles.btn}
          onPress={disabled ? undefined : confirm}
        >
          <Text style={disabled ? styles.btnTextOff : styles.btnText}>
            {confirmLabel(acked, busy)}
          </Text>
        </Pressable>
        {!acked ? (
          <Pressable
            accessibilityRole="button"
            testID={`childdone-revert-${thread.agentId}`}
            style={styles.sub}
            onPress={busy ? undefined : submitRevert}
          >
            <Text style={styles.subText}>差し戻し</Text>
          </Pressable>
        ) : null}
        {navigation ? (
          <Pressable accessibilityRole="button" style={styles.sub} onPress={open}>
            <Text style={styles.subText}>スレを開く</Text>
          </Pressable>
        ) : null}
      </View>
      {!acked && !thread.summaryItemId ? (
        <Text style={styles.meta}>
          完了まとめが確認箱に無いため、ここからは確認できません。「スレを開く」から手でアーカイブしてください。
        </Text>
      ) : null}
      {!acked && thread.summaryItemId ? (
        <Text style={styles.meta}>
          確認すると数分以内にアーカイブされます(アーカイブは既存の定期処理が行います)。
          子スレ専用の作業フォルダだけが畳まれ、司令塔と同じ作業フォルダのスレはスレだけ畳みます。
        </Text>
      ) : null}
      {acked ? (
        <Text style={styles.meta}>アーカイブ待ちです(数分以内に一覧から消えます)</Text>
      ) : null}
    </View>
  );
}

function formatDate(ts: number): string {
  if (!ts) return "日時なし";
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
