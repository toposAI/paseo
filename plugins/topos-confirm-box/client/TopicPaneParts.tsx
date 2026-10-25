/** 話題単位表示の小部品(CardChatPane の分岐を増やさないために切り出し)。 */
import { Pressable, Text } from "react-native";
import { TOPIC_REPLY_OVERDUE_S } from "../shared/card-pane.js";

type Style = object;

export function ScopeToggle({
  topicMode,
  onPress,
  style,
  textStyle,
}: {
  topicMode: boolean;
  onPress: () => void;
  style: Style;
  textStyle: Style;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="表示範囲の切り替え"
      style={style}
      onPress={onPress}
    >
      <Text style={textStyle}>{topicMode ? "この話題だけ" : "スレ全体"}</Text>
    </Pressable>
  );
}

export function TopicEmpty({ style }: { style: Style }) {
  return (
    <Text style={style}>
      この話題の会話はまだありません。送ると上位スレに届き、上位スレが返信IDつきで返した返事だけがここに並びます。
    </Text>
  );
}

export function PendingReplyHint({ ageS, style }: { ageS: number; style: Style }) {
  return (
    <Text style={style} testID="pane-reply-pending">
      {ageS >= TOPIC_REPLY_OVERDUE_S
        ? "返事がまだ来ていません(上位スレが say で返していない可能性)。「スレ全体」で上位スレの返事を確認できます"
        : "返事待ち(上位スレが返すと、ここに出ます)"}
    </Text>
  );
}
