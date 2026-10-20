/**
 * 統合確認箱の画面本体。全画面(サイドバーから)とヘッダボタンのポップオーバーで共用する。
 *
 * v1: 一覧(優先度順)・展開・背景の4段階開示・選択して決定を記録・Paseo承認待ちへの応答。
 * 決定の記録は押した時だけ(自動では何も決めない)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
} from "../shared/contract.js";
import type { ConfirmBoxDepth, ConfirmBoxItem, ConfirmBoxListOutput } from "../shared/contract.js";

const REFRESH_MS = 30_000;

export function ConfirmBoxView({ theme }: Pick<PluginHostProps, "theme">) {
  const list = useRpc(confirmBoxListRpc);
  const decide = useRpc(confirmBoxDecideRpc);
  const permit = useRpc(confirmBoxPermitRpc);
  const [data, setData] = useState<ConfirmBoxListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [depth, setDepth] = useState<ConfirmBoxDepth>("list");
  const [notice, setNotice] = useState<string>("");

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
      subject: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      text: { color: c.foreground, fontSize: 13 },
      badge: { color: c.accent, fontSize: 11 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      btn: {
        backgroundColor: c.surface2,
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 10,
      },
      btnRec: {
        backgroundColor: c.accent,
        borderRadius: 6,
        paddingVertical: 6,
        paddingHorizontal: 10,
      },
      btnText: { color: c.foreground, fontSize: 13 },
      btnRecText: { color: c.accentForeground, fontSize: 13 },
      warn: { color: c.statusWarning, fontSize: 12 },
    }),
    [c],
  );

  const toggle = useCallback((id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    setDepth("expanded");
  }, []);
  const openBackground = useCallback(() => setDepth("background"), []);

  const choose = useCallback(
    async (item: ConfirmBoxItem, optionId: string) => {
      try {
        if (item.kind === "permit" && item.agentId) {
          const requestId = item.id.split(":").slice(2).join(":");
          const r = await permit({ agentId: item.agentId, requestId, actionId: optionId });
          setNotice(r.message);
        } else if (item.key) {
          const r = await decide({
            key: item.key,
            chosen: optionId,
            recommended: item.recommended,
            depth,
            reason: "",
            source: "paseo-plugin",
          });
          setNotice(r.message);
        } else {
          setNotice("この項目は決定を記録できません(key なし)");
        }
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      void reload();
    },
    [decide, permit, depth, reload],
  );

  return (
    <ScrollView style={s.root} contentContainerStyle={s.body}>
      {error ? <Text style={s.warn}>読み込めません: {error}</Text> : null}
      {data?.sources
        .filter((x) => !x.ok)
        .map((x) => (
          <Text key={x.id} style={s.warn}>
            {x.label}: {x.detail}
          </Text>
        ))}
      {notice ? <Text style={s.muted}>{notice}</Text> : null}
      {data && data.items.length === 0 ? <Text style={s.muted}>判断待ちはありません</Text> : null}
      {data?.items.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          styles={s}
          open={openId === item.id}
          showBackground={depth === "background"}
          onToggle={toggle}
          onBackground={openBackground}
          onChoose={choose}
        />
      ))}
    </ScrollView>
  );
}

type Styles = Record<string, object>;

function BackgroundBlock({
  item,
  styles,
  show,
  onOpen,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  show: boolean;
  onOpen: () => void;
}) {
  if (!item.background) return null;
  if (show) return <Text style={styles.text}>{item.background}</Text>;
  return (
    <Pressable accessibilityRole="button" onPress={onOpen}>
      <Text style={styles.badge}>背景を開く</Text>
    </Pressable>
  );
}

function OptionButton({
  item,
  option,
  styles,
  onChoose,
}: {
  item: ConfirmBoxItem;
  option: ConfirmBoxItem["options"][number];
  styles: Styles;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
}) {
  const rec = option.id === item.recommended;
  const press = useCallback(() => void onChoose(item, option.id), [onChoose, item, option.id]);
  return (
    <Pressable accessibilityRole="button" style={rec ? styles.btnRec : styles.btn} onPress={press}>
      <Text style={rec ? styles.btnRecText : styles.btnText}>
        {option.label}
        {rec ? "(推奨)" : ""}
      </Text>
    </Pressable>
  );
}

function ItemCard({
  item,
  styles,
  open,
  showBackground,
  onToggle,
  onBackground,
  onChoose,
}: {
  item: ConfirmBoxItem;
  styles: Styles;
  open: boolean;
  showBackground: boolean;
  onToggle: (id: string) => void;
  onBackground: () => void;
  onChoose: (item: ConfirmBoxItem, optionId: string) => Promise<void>;
}) {
  const toggle = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" onPress={toggle}>
        <Text style={styles.badge}>
          {PRIORITY_LABEL[item.priority]} · {KIND_LABEL[item.kind]}
          {item.state === "approved" ? " · 決定済み" : ""}
        </Text>
        <Text style={styles.subject}>{item.subject}</Text>
        {open ? null : (
          <Text style={styles.muted} numberOfLines={2}>
            {item.summary}
          </Text>
        )}
      </Pressable>
      {open ? (
        <>
          <Text style={styles.text}>{item.summary}</Text>
          <BackgroundBlock
            item={item}
            styles={styles}
            show={showBackground}
            onOpen={onBackground}
          />
          <View style={styles.row}>
            {item.options.map((o) => (
              <OptionButton key={o.id} item={item} option={o} styles={styles} onChoose={onChoose} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}
