import { useCallback, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { formatMessageTimestamp } from "@/utils/time";

interface FoldedUserMessageProps {
  /** One-line summary shown while folded. */
  preview: string;
  /** Sender named by the server's agent-message envelope, when it recorded one. */
  sender: string | null;
  /** Full text, revealed only once the reader expands the row. */
  text: string;
  timestamp: number;
}

/**
 * A long user turn in a relay thread (完了箱C), folded to a single line: the relay's own answer
 * below it stays the main content, and the whole message is one press away.
 */
export function FoldedUserMessage({ preview, sender, text, timestamp }: FoldedUserMessageProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const handleToggle = useCallback(() => setIsExpanded((expanded) => !expanded), []);
  const accessibilityState = useMemo(() => ({ expanded: isExpanded }), [isExpanded]);
  const lineLabel = sender
    ? t("message.relayTurn.fromSender", { sender })
    : t("message.relayTurn.fromSenderPreview");
  return (
    <Pressable
      style={foldedMessageStylesheet.container}
      onPress={handleToggle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID="user-message-folded-toggle"
    >
      <Text style={foldedMessageStylesheet.label}>
        {isExpanded ? t("message.relayTurn.hide") : `${lineLabel}: ${preview}`}
      </Text>
      <Text selectable style={foldedMessageStylesheet.label}>
        {formatMessageTimestamp(new Date(timestamp))}
      </Text>
      {isExpanded ? (
        <Text selectable style={foldedMessageStylesheet.raw}>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}

const foldedMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "flex-end",
    maxWidth: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginVertical: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  raw: {
    width: "100%",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
    fontFamily: theme.fontFamily.mono,
  },
}));
