/**
 * 確認箱カードの添付画像を、画面いっぱい(縦横比を保ち、はみ出さない)で見る拡大表示。
 * 閉じる: ✕・背景を押す・Esc。複数枚は ‹ › と ←/→ キーで前後へ移る。
 * iPhone のピンチ拡大は、Modal の中身が普通の div のままなので標準の振る舞いを妨げない(touch-action を触らない)。
 */
import { useCallback, useEffect, useMemo } from "react";
import { Image, Modal, Platform, Pressable, Text, View } from "react-native";
import { neighborIndex } from "../shared/image-nav.js";

interface Source {
  uri: string;
}

export function ImageLightbox({
  sources,
  index,
  onChange,
  onClose,
}: {
  sources: Source[];
  /** 開いている画像の番号。null なら閉じている。 */
  index: number | null;
  onChange: (index: number) => void;
  onClose: () => void;
}) {
  const count = sources.length;
  const current = index === null ? null : (sources[index] ?? null);
  const prev = useCallback(() => {
    if (index !== null) onChange(neighborIndex(index, count, -1));
  }, [index, count, onChange]);
  const next = useCallback(() => {
    if (index !== null) onChange(neighborIndex(index, count, 1));
  }, [index, count, onChange]);

  // Esc で閉じる・←/→ で前後(Web のみ。Modal の onRequestClose は Esc で呼ばれない環境がある)。
  useEffect(() => {
    if (Platform.OS !== "web" || current === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && count > 1) prev();
      else if (e.key === "ArrowRight" && count > 1) next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, count, onClose, prev, next]);

  const st = useMemo(
    () => ({
      wrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)" },
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
          <Text style={st.title}>{index === null ? "" : `${index + 1} / ${count}`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="閉じる" onPress={onClose}>
            <Text style={st.close}>✕</Text>
          </Pressable>
        </View>
        <View style={st.body}>
          {count > 1 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="前の画像" onPress={prev}>
              <Text style={st.nav}>‹</Text>
            </Pressable>
          ) : null}
          {/* 背景(画像まわりの黒い所)を押すと閉じる。ピンチは click にならないので拡大操作では閉じない。 */}
          <Pressable accessibilityLabel="背景を押して閉じる" style={st.backdrop} onPress={onClose}>
            {current ? (
              <Image
                accessibilityLabel="拡大した添付画像"
                source={current}
                style={st.img}
                resizeMode="contain"
              />
            ) : null}
          </Pressable>
          {count > 1 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="次の画像" onPress={next}>
              <Text style={st.nav}>›</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
