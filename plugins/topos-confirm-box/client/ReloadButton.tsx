/**
 * 一覧の右上に置く小さな「更新」ボタン(2026-10-24 ユーザー依頼)。
 *
 * 定期取得(30秒)や合図が遅れた/届かなかった時に、**サーバーの最新を取り直して**もう不要なカード
 * (取り下げ済み・既に畳まれた等)を手で消せるようにする保険。取得中は回転で示し、失敗は小さく1行だけ出す。
 * 失敗しても前回の一覧は残す(消えて「無くなった」と誤読されないように)。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";

/** `accessibilityState` は毎回新しいオブジェクトを渡さない(react-perf)。 */
const A11Y_BUSY = { disabled: true, busy: true } as const;
const A11Y_IDLE = { disabled: false, busy: false } as const;

export function ReloadButton({
  colors,
  onRefresh,
  testID = "confirm-box-reload",
}: {
  colors: Pick<PluginTheme["colors"], "foregroundMuted" | "statusWarning">;
  /** 取得できたら true。一覧側の状態(カード・エラー文)は呼び出し元が更新する。 */
  onRefresh: () => Promise<boolean>;
  /** 実画面の確認で押す位置を名指しするため(react-native-web では data-testid になる)。 */
  testID?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inflight = useRef(false);

  const press = useCallback(() => {
    if (inflight.current) return; // 二度押しで取得を重ねない
    inflight.current = true;
    setBusy(true);
    setFailed(false);
    void (async () => {
      let ok = false;
      try {
        ok = await onRefresh();
      } catch {
        ok = false;
      } finally {
        inflight.current = false;
        setBusy(false);
        setFailed(!ok);
      }
    })();
  }, [onRefresh]);

  const s = useMemo(
    () => ({
      root: { alignItems: "flex-end" as const, gap: 2, flexShrink: 0 },
      btn: {
        width: 32,
        height: 32,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      failed: {
        color: colors.statusWarning,
        fontSize: 11,
        maxWidth: 220,
        textAlign: "right" as const,
      },
    }),
    [colors.statusWarning],
  );

  return (
    <View style={s.root}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel="最新の状態に更新"
        accessibilityHint="サーバーから最新を取り直し、もう不要なカードを消します"
        accessibilityState={busy ? A11Y_BUSY : A11Y_IDLE}
        disabled={busy}
        hitSlop={8}
        style={s.btn}
        onPress={press}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
        ) : (
          <Icon name="RotateCw" size={16} color={colors.foregroundMuted} />
        )}
      </Pressable>
      {failed ? <Text style={s.failed}>更新できませんでした</Text> : null}
    </View>
  );
}
