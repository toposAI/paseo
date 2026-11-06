/**
 * カードの添付画像と見出し(ce91 の表示差し戻し)。
 * - 画像はカード幅いっぱいに描く。縦長は SHOT_MAX_HEIGHT で切る(細部は全画面と拡大で見る)。
 * - 見出しの「(n/m枚目)」は省略されても必ず残す。
 */
import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { ImageLoadEventData, NativeSyntheticEvent } from "react-native";
import {
  SHOT_FALLBACK_RATIO,
  SHOT_MAX_HEIGHT,
  shotRatio,
  splitShotCount,
} from "../shared/card-title.js";
import { joinTitleWords } from "../shared/windowb-instructions.js";

const FRAME = {
  width: "100%" as const,
  maxHeight: SHOT_MAX_HEIGHT,
  overflow: "hidden" as const,
  borderRadius: 8,
};
// 枚数は題の下に独立して置く(2026-11-07 指摘)。横並びにすると、題が2行になったとき
// 2行目の語の途中にバッジが挟まって見える(「(家族 (2/2枚目) 版)」)。
const SUFFIX = { color: "#8b93a1", fontSize: 12, marginTop: 2 };

export function CardShot({
  source,
  index,
  label,
  onZoom,
}: {
  source: { uri: string };
  index: number;
  label: string;
  onZoom: (index: number) => void;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  const press = useCallback(() => onZoom(index), [onZoom, index]);
  const loaded = useCallback((e: NativeSyntheticEvent<ImageLoadEventData>) => {
    const loadedSource = e.nativeEvent?.source;
    setRatio(shotRatio(loadedSource?.width ?? 0, loadedSource?.height ?? 0));
  }, []);
  const frame = useMemo(() => ({ ...FRAME, aspectRatio: ratio ?? SHOT_FALLBACK_RATIO }), [ratio]);
  const imgStyle = useMemo(
    () => ({ width: "100%" as const, aspectRatio: ratio ?? SHOT_FALLBACK_RATIO }),
    [ratio],
  );
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}を拡大`} onPress={press}>
      <View style={frame}>
        {source.uri ? (
          <Image
            accessibilityLabel={label}
            source={source}
            style={imgStyle}
            resizeMode="cover"
            onLoad={loaded}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/** 見出し。「(n/m枚目)」は縮めず右に残し、本文側だけが省略・折り返しされる。 */
export function CardTitle({
  subject,
  style,
  numberOfLines,
}: {
  subject: string;
  style: object;
  numberOfLines?: number;
}) {
  const { title, suffix } = splitShotCount(subject);
  // 題は語の途中で折らない(指示一覧と同じ joinTitleWords。2026-11-07 指摘「家族／版」)。
  const joined = useMemo(() => joinTitleWords(title), [title]);
  if (!suffix) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {joined}
      </Text>
    );
  }
  return (
    <View>
      <Text style={style} numberOfLines={numberOfLines ?? 2}>
        {joined}
      </Text>
      <Text style={SUFFIX}>{suffix}</Text>
    </View>
  );
}
