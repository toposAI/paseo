import { useCallback, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

export interface UserMessageFoldView {
  /** One-line summary shown while folded. */
  preview: string;
  /** Sender named by the server's agent-message envelope, when it recorded one. */
  sender: string | null;
}

interface FoldedUserMessageProps extends UserMessageFoldView {
  /** Full text, revealed only once the reader expands the row. */
  text: string;
}

/**
 * The body of a long incoming turn in a relay thread (完了箱C), folded to a single line: the
 * relay's own answer below it stays the main content, and the whole message is one press away.
 * It renders inside the ordinary user bubble, so the reader keeps copy, rewind and the pending
 * state of the message it belongs to.
 */
export function FoldedUserMessage({ preview, sender, text }: FoldedUserMessageProps) {
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
    alignSelf: "stretch",
    maxWidth: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  raw: {
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
