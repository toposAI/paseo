/**
 * 画像を開いたときの下のコメント欄。**どの画像ビューアでも必ず出す**
 * (2026-11-06 ユーザー指示「確認箱、画像開くと下にコメント欄が出るやつとでないやつがある。コメント欄だして」)。
 *
 * コメントを付けてもカードは閉じない(2026-11-08 ユーザー逐語「1枚の画像にコメントした直後にその確認箱
 * 終了にするのやめて、僕が全部の画像を確認した後に僕が手動で完了ボタンを押します」)。閉じるのはカードの
 * 「完了」ボタンだけ。**送信は「控える」の意味**で、UI最終チェックのカードでは呼び出し側が溜めるだけで
 * 実際の送信は「完了」で1通にまとめて行う(2026-11-08 ユーザー逐語「全ての画像にコメントして完了ボタンを
 * 押したときに全部まとめて飛ばせばよくない？」)。返事は求めない(送信側で「返事不要」を明記)。
 * `send` が false を返したら(=どこにも届かなかった)入力は残して理由を出す。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
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
  disabledReason,
  testID,
}: {
  /** どの画像へのコメントか(画像名)。文の先頭に付けて投函元へ伝える。 */
  label: string;
  colors: ImageCommentColors;
  /** 1件分を渡す(渡し先が溜めるか送るかは呼び出し側)。受け取れなければ false(入力は残す)。 */
  send: ((text: string) => Promise<boolean>) | null;
  /** 送れない理由(あれば入力欄の代わりに出す)。 */
  disabledReason?: string | null;
  testID?: string;
}) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  // 送れた知らせを警告色(赤系)で出さないための区別(2026-11-08 出口レビュー指摘5)。
  const [noticeOk, setNoticeOk] = useState(false);
  // 送信中は押し直しを黙って無視する(2026-11-06 出口レビュー指摘4)。送信側も送信中は false を
  // 返すため、素通しすると二度押しで「送れませんでした」と誤って出てしまう。
  const busyRef = useRef(false);
  const appendDictated = useCallback((said: string) => setText((cur) => cur + said), []);
  const tools = usePaneInputTools(appendDictated);
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
      setNoticeOk(false);
      setNotice("送れませんでした(投函元スレに届いていません)");
      return;
    }
    setText("");
    setNoticeOk(true);
    setNotice("コメントを控えました(完了でまとめて送ります)");
  }, [text, send, label]);
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
      noticeOk: { color: "#9fd6a8", fontSize: 12, padding: 8 },
    }),
    [colors.surface0, colors.surface1],
  );
  return (
    <View style={st.dock}>
      {notice ? <Text style={noticeOk ? st.noticeOk : st.notice}>{notice}</Text> : null}
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
