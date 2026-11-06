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

const FRAME = {
  width: "100%" as const,
  maxHeight: SHOT_MAX_HEIGHT,
  overflow: "hidden" as const,
  borderRadius: 8,
};
const ROW = {
  flexDirection: "row" as const,
  alignItems: "baseline" as const,
  gap: 6,
  flexWrap: "nowrap" as const,
};
const SHRINK = { flexShrink: 1 };
const KEEP = { flexShrink: 0 };

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
    const { width, height } = e.nativeEvent.source;
    setRatio(shotRatio(width, height));
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
  const shrinkStyle = useMemo(() => [style, SHRINK], [style]);
  const keepStyle = useMemo(() => [style, KEEP], [style]);
  if (!suffix) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {subject}
      </Text>
    );
  }
  return (
    <View style={ROW}>
      <Text style={shrinkStyle} numberOfLines={numberOfLines ?? 2}>
        {title}
      </Text>
      <Text style={keepStyle}>{suffix}</Text>
    </View>
  );
}
