/**
 * 「通知」タブ。**ユーザーが見るだけで判断不要**のお知らせ(監視系ウォッチドッグの異常・日次サマリ等)を並べる。
 *
 * 判定は「選択肢を持たない箱の項目」= 決めることが無いお知らせ。家族報告の新着通知
 * (`topos_feedback`)と子スレ完了まとめ(`child_thread_report`)は専用タブがあるので除く。
 *
 * 既読は箱の `ack` イベントを1行追記するだけ(本体ストアと同じ契約)。`ackall` は
 * その時点以前の未読をまとめて既読にする。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import {
  confirmBoxAckAllRpc,
  confirmBoxAckRpc,
  confirmBoxListRpc,
  notificationTabRows,
} from "../shared/contract.js";
import type { ConfirmBoxItem, ConfirmBoxListOutput } from "../shared/contract.js";
import { notifyBoxChanged } from "./events.js";

const REFRESH_MS = 30_000;

/** `accessibilityState` は毎回新しいオブジェクトを渡さない(react-perf)。 */
const BUSY = { disabled: true } as const;
const IDLE = { disabled: false } as const;

/** 見出し文。読み込み中/エラー/件数の3状態をここで畳む(JSX に入れ子の三項を書かない)。 */
function describe(error: string | null, loaded: boolean, total: number, unread: number): string {
  if (error) return `取得できません: ${error}`;
  if (!loaded) return "読み込み中…";
  return `通知 ${total}件(未読 ${unread}件)`;
}

export function NotificationsView({ theme }: Pick<PluginHostProps, "theme">) {
  const list = useRpc(confirmBoxListRpc);
  const ack = useRpc(confirmBoxAckRpc);
  const ackAll = useRpc(confirmBoxAckAllRpc);
  const [data, setData] = useState<ConfirmBoxListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [showRead, setShowRead] = useState(false);
  const [busy, setBusy] = useState(false);

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
      root: { gap: 8 },
      card: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
      },
      cardRead: {
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 6,
        opacity: 0.6,
      },
      title: { color: c.foreground, fontSize: 14, fontWeight: "600" as const },
      meta: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      warn: { color: c.statusWarning, fontSize: 12 },
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      btn: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
      },
      btnText: { color: c.accentForeground, fontSize: 13 },
      sub: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
      },
      subOff: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        opacity: 0.5,
      },
      subText: { color: c.foreground, fontSize: 13 },
    }),
    [c],
  );

  const items = useMemo(() => notificationTabRows(data?.items ?? [], true), [data]);
  const unread = items.filter((i) => i.state === "new").length;
  const visible = showRead ? items : items.filter((i) => i.state === "new");
  const header = describe(error, data !== null, items.length, unread);
  const toggleShowRead = useCallback(() => setShowRead((v) => !v), []);

  const markRead = useCallback(
    async (item: ConfirmBoxItem) => {
      try {
        const r = await ack({ id: item.id, action: "read" });
        setNotice(r.message);
        notifyBoxChanged();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      void reload();
    },
    [ack, reload],
  );

  const markAll = useCallback(async () => {
    setBusy(true);
    try {
      const r = await ackAll({});
      setNotice(r.message);
      notifyBoxChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    void reload();
  }, [ackAll, reload]);

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Text style={s.meta}>{header}</Text>
        {unread > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={busy ? BUSY : IDLE}
            style={busy ? s.subOff : s.btn}
            onPress={busy ? undefined : markAll}
          >
            <Text style={busy ? s.subText : s.btnText}>{busy ? "処理中…" : "すべて既読"}</Text>
          </Pressable>
        ) : null}
      </View>
      {notice ? <Text style={s.meta}>{notice}</Text> : null}
      {items.length > 0 ? (
        <View style={s.row}>
          <Pressable accessibilityRole="button" style={s.sub} onPress={toggleShowRead}>
            <Text style={s.subText}>{showRead ? "既読を隠す" : "既読も表示"}</Text>
          </Pressable>
        </View>
      ) : null}
      {data && visible.length === 0 && !error ? (
        <Text style={s.meta}>
          {items.length === 0 ? "通知はありません" : "未読の通知はありません"}
        </Text>
      ) : null}
      {visible.map((item) => (
        <NotificationCard
          key={item.id}
          item={item}
          styles={s}
          open={openId === item.id}
          onToggle={setOpenId}
          onRead={markRead}
        />
      ))}
    </View>
  );
}

function NotificationCard({
  item,
  styles,
  open,
  onToggle,
  onRead,
}: {
  item: ConfirmBoxItem;
  styles: Record<string, object>;
  open: boolean;
  onToggle: (id: string | null) => void;
  onRead: (item: ConfirmBoxItem) => Promise<void>;
}) {
  const read = item.state !== "new";
  const press = useCallback(() => onToggle(open ? null : item.id), [onToggle, open, item.id]);
  const markRead = useCallback(() => void onRead(item), [onRead, item]);
  const body = item.background || item.summary;
  return (
    <View style={read ? styles.cardRead : styles.card}>
      <View style={styles.head}>
        <Text style={styles.meta}>{item.source}</Text>
        <Text style={styles.meta}>{formatCreated(item.ts)}</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={press}>
        <Text style={styles.title}>{item.subject}</Text>
        {!open && body ? (
          <Text style={styles.text} numberOfLines={2}>
            {body}
          </Text>
        ) : null}
      </Pressable>
      {open && body ? <Text style={styles.text}>{body}</Text> : null}
      {open && !body ? <Text style={styles.meta}>本文はありません</Text> : null}
      <View style={styles.row}>
        {read ? (
          <Text style={styles.meta}>既読</Text>
        ) : (
          <Pressable accessibilityRole="button" style={styles.sub} onPress={markRead}>
            <Text style={styles.subText}>既読にする</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function formatCreated(ts: number): string {
  let ms = 0;
  if (ts > 1e12) ms = ts;
  else if (ts > 1e9) ms = ts * 1000;
  if (ms === 0) return "日時なし";
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
