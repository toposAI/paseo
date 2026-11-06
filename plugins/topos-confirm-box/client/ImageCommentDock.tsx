/**
 * 画像を開いたときの下のコメント欄。**どの画像ビューアでも必ず出す**
 * (2026-11-06 ユーザー指示「確認箱、画像開くと下にコメント欄が出るやつとでないやつがある。コメント欄だして」)。
 *
 * 送信に成功したら、その場でカードを完了にして閉じる(同じ指示「コメント送信したらそのカードそのまま完了にして」)。
 * 閉じ方はカードの「完了」ボタンと同じ経路(onDone)に任せる。返事は求めない(送信側で「返事不要」を明記)。
 * **閉じるのは「届いたと確認できたとき」だけ**(2026-11-06 ユーザー逐語「投稿元たどれないなら、総司令塔が
 * 引き取るってなってるでしょ」)。宛先の解決は送信側の順(投函元 → 閉じていれば復元 → 総司令塔)に任せ、
 * `send` が false を返したら(=どこにも届かなかった)カードは閉じずに残して理由を出す。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { imageCommentText } from "../shared/card-pane.js";
import { PaneComposer } from "./PaneComposer.js";
import { usePaneInputTools } from "./usePaneInputTools.js";

const COMMENT_MAX = 2000;

/** この部品が使う色だけ。UI確認カード(テーマ色)と一般カード(質問部品の色)の両方から渡せる。 */
export interface ImageCommentColors {
  accent: string;
  accentForeground: string;
  foreground: string;
  foregroundMuted: string;
  border: string;
  surface0: string;
  surface1?: string;
  surface2: string;
}

export function ImageCommentDock({
  label,
  colors,
  send,
  onDone,
  disabledReason,
  testID,
}: {
  /** どの画像へのコメントか(画像名)。文の先頭に付けて投函元へ伝える。 */
  label: string;
  colors: ImageCommentColors;
  /** 1通送る。送れなければ false(入力は残す)。 */
  send: ((text: string) => Promise<boolean>) | null;
  /** カードを完了にして閉じる。無ければ「完了」ボタンを出さない。 */
  onDone: (() => void) | null;
  /** 送れない理由(あれば入力欄の代わりに出す)。 */
  disabledReason?: string | null;
  testID?: string;
}) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  // 送信中は押し直しを黙って無視する(2026-11-06 出口レビュー指摘4)。送信側も送信中は false を
  // 返すため、素通しすると二度押しで「送れませんでした」と誤って出てしまう。
  const busyRef = useRef(false);
  const appendDictated = useCallback((said: string) => setText((cur) => cur + said), []);
  const tools = usePaneInputTools(appendDictated);
  const donePress = useCallback(() => onDone?.(), [onDone]);
  const submit = useCallback(async () => {
    const t = text.trim();
    if (!t || !send || busyRef.current) return;
    busyRef.current = true;
    let ok = false;
    try {
      ok = await send(imageCommentText(label, t));
    } finally {
      busyRef.current = false;
    }
    if (!ok) {
      setNotice("送れませんでした(投函元スレに届いていません)");
      return;
    }
    setText("");
    setNotice("");
    // 送れたらそのカードは完了(2026-11-06 ユーザー指示)。閉じるのは呼び出し側の onDone。
    onDone?.();
  }, [text, send, label, onDone]);
  const submitPress = useCallback(() => void submit(), [submit]);
  // 入力欄の部品は surface1 を必須で取る。一般カードの色には無いので surface0 で埋める。
  const composerColors = useMemo(
    () => ({ ...colors, surface1: colors.surface1 ?? colors.surface0 }),
    // colors 自体が変われば surface0 も変わる(個別に並べると「余計な依存」と叱られる)。
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps
    [colors],
  );
  const st = useMemo(
    () => ({
      dock: {
        backgroundColor: colors.surface1 ?? colors.surface0 ?? "transparent",
        paddingBottom: 12,
      },
      notice: { color: "#ffb4a8", fontSize: 12, padding: 8 },
      // 幅いっぱいに広げて中央に置く(幅によって右端へ寄ったり隠れたりしない)。
      doneRow: { padding: 8 },
      done: {
        backgroundColor: colors.accent,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        minHeight: 44,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      doneText: { color: colors.accentForeground, fontSize: 15, fontWeight: "600" as const },
    }),
    [colors.surface0, colors.surface1, colors.accent, colors.accentForeground],
  );
  return (
    <View style={st.dock}>
      {onDone ? (
        <View style={st.doneRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="このカードを完了にして閉じる"
            style={st.done}
            onPress={donePress}
          >
            <Text style={st.doneText}>このカードを完了</Text>
          </Pressable>
        </View>
      ) : null}
      {notice ? <Text style={st.notice}>{notice}</Text> : null}
      {/* マイクが使えない環境で押したときの理由をここに出す(本体の composer にも案内が出る)。 */}
      {tools.toolNotice ? <Text style={st.notice}>{tools.toolNotice}</Text> : null}
      <PaneComposer
        colors={composerColors}
        text={text}
        onChangeText={setText}
        tools={tools}
        disabledReason={send ? null : (disabledReason ?? "この画面では送れません")}
        placeholder="この画像へのコメント"
        maxLength={COMMENT_MAX}
        sendable={text.trim().length > 0 && send !== null}
        onSend={submitPress}
        testID={testID}
      />
    </View>
  );
}
