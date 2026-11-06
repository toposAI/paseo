/**
 * 確認箱カードの添付画像を、画面いっぱい(縦横比を保ち、はみ出さない)で見る拡大表示。
 * 閉じる: ✕・Esc(PC は画像を押しても。Modal の onRequestClose)。複数枚は ‹ › と ←/→ キーで前後へ移る。
 * 指で操作する端末(iPhone)は ZoomableImage: ピンチ・ダブルタップで拡大し、ドラッグで動かせる(元の解像度のまま)。
 *   画像の上を押しても閉じない(拡大操作と取り合うため)。閉じるのは ✕・Esc。
 * PC は従来どおり(画像を押すと閉じる。拡大はブラウザ標準のトラックパッド)。
 */
import { useCallback, useEffect, useMemo } from "react";
import { Image, Modal, Platform, Pressable, Text, View } from "react-native";
import { neighborIndex } from "../shared/image-nav.js";
import type { ImageCommentColors } from "./ImageCommentDock.js";
import { ImageCommentDock } from "./ImageCommentDock.js";
import { isTouchDevice, ZoomableImage } from "./ZoomableImage.js";

interface Source {
  uri: string;
}

/** 画像の下に出すコメント欄(無い画面では欄も出さない)。 */
export interface ImageComment {
  /** どの画像へのコメントか(画像名)。 */
  label: string;
  send: ((text: string) => Promise<boolean>) | null;
  /** 送れたときにカードを完了にして閉じる。 */
  onDone: (() => void) | null;
  /** 送れない理由(あれば欄に出す)。 */
  disabledReason?: string | null;
  testID?: string;
}

export function ImageLightbox({
  sources,
  index,
  onChange,
  onClose,
  colors,
  comment,
}: {
  sources: Source[];
  /** 開いている画像の番号。null なら閉じている。 */
  index: number | null;
  onChange: (index: number) => void;
  onClose: () => void;
  /** コメント欄の色。 */
  colors?: ImageCommentColors;
  /** 下に出すコメント欄。2026-11-06 ユーザー指示「どの画像を開いても下にコメント欄を出す」。 */
  comment?: ImageComment | null;
}) {
  const touch = isTouchDevice();
  const count = sources.length;
  const current = index === null ? null : (sources[index] ?? null);
  const prev = useCallback(() => {
    if (index !== null) onChange(neighborIndex(index, count, -1));
  }, [index, count, onChange]);
  const next = useCallback(() => {
    if (index !== null) onChange(neighborIndex(index, count, 1));
  }, [index, count, onChange]);

  // 枚数が減るなどで開いていた番号が無くなったら、状態も閉じる(後で枚数が戻っても勝手に開かない)。
  useEffect(() => {
    if (index !== null && current === null) onClose();
  }, [index, current, onClose]);

  // ←/→ で前後(Web のみ)。Esc は react-native-web の Modal が keyup で onRequestClose を呼ぶのでここでは扱わない。
  useEffect(() => {
    if (Platform.OS !== "web" || current === null || count < 2) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, count, prev, next]);

  const st = useMemo(
    () => ({
      // 背景は透かさない(2026-11-07 指摘「全画面の背景が透けて後ろの一覧が読める」)。
      wrap: { flex: 1, backgroundColor: "#000" },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingTop: 40,
        paddingHorizontal: 12,
        paddingBottom: 8,
      },
      title: { color: "#fff", fontSize: 14 },
      close: { color: "#fff", fontSize: 24, paddingHorizontal: 12, paddingVertical: 4 },
      // マウスで押した後に残る緑のフォーカス枠を消す(Web だけ)。キーボードは Esc で閉じられるので操作は損なわない。
      press: Platform.select({
        web: { outlineWidth: 0, borderRadius: 6 },
        default: { borderRadius: 6 },
      }),
      body: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        paddingHorizontal: 4,
        paddingBottom: 16,
      },
      backdrop: { flex: 1, alignSelf: "stretch" as const },
      img: { flex: 1, alignSelf: "stretch" as const },
      nav: { color: "#fff", fontSize: 32, paddingHorizontal: 10, paddingVertical: 24 },
    }),
    [],
  );

  return (
    <Modal visible={current !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={st.wrap}>
        <View style={st.bar}>
          {/* カード側の「(n/m枚目)」と同じ書き方に揃える(2026-11-07 指摘「1 / 1 と (1/2枚目) が別物」)。 */}
          <Text style={st.title}>{index === null ? "" : `(${index + 1}/${count}枚目)`}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="閉じる"
            style={st.press}
            onPress={onClose}
          >
            <Text style={st.close}>✕</Text>
          </Pressable>
        </View>
        <View style={st.body}>
          {count > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="前の画像"
              style={st.press}
              onPress={prev}
            >
              <Text style={st.nav}>‹</Text>
            </Pressable>
          ) : null}
          {touch ? (
            <View style={st.backdrop}>
              {current ? <ZoomableImage uri={current.uri} label="拡大した添付画像" /> : null}
            </View>
          ) : (
            /* PC は従来どおり: 画像の上を含め、‹ › 以外の所を押すと閉じる。拡大はブラウザ標準(トラックパッド)。 */
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="画像を押して閉じる"
              style={st.backdrop}
              onPress={onClose}
            >
              {current ? (
                <Image
                  accessibilityLabel="拡大した添付画像"
                  source={current}
                  style={st.img}
                  resizeMode="contain"
                />
              ) : null}
            </Pressable>
          )}
          {count > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="次の画像"
              style={st.press}
              onPress={next}
            >
              <Text style={st.nav}>›</Text>
            </Pressable>
          ) : null}
        </View>
        {comment && colors ? (
          <ImageCommentDock
            label={comment.label}
            colors={colors}
            send={comment.send}
            onDone={comment.onDone}
            disabledReason={comment.disabledReason}
            testID={comment.testID ?? "lightbox-image-composer"}
          />
        ) : null}
      </View>
    </Modal>
  );
}
