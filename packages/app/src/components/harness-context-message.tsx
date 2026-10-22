import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMessageTimestamp } from "@/utils/time";

interface HarnessContextMessageProps {
  /** Raw text, revealed only once the reader expands the row. */
  text: string;
  timestamp: number;
}

/**
 * A user turn that held nothing but what the harness injected (system reminders, the
 * environment update, tool records). It normally renders as a single muted line; the
 * text stays reachable on demand.
 */
export function HarnessContextMessage({ text, timestamp }: HarnessContextMessageProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const handleToggle = useCallback(() => setIsExpanded((expanded) => !expanded), []);
  return (
    <Pressable
      style={harnessContextStylesheet.container}
      onPress={handleToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: isExpanded }}
      testID="user-message-harness-context-toggle"
    >
      <Text style={harnessContextStylesheet.label}>
        {isExpanded ? t("message.harnessContext.hide") : t("message.harnessContext.show")}
      </Text>
      <Text selectable style={harnessContextStylesheet.label}>
        {formatMessageTimestamp(new Date(timestamp))}
      </Text>
      {isExpanded ? (
        <Text selectable style={harnessContextStylesheet.raw}>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}

const harnessContextStylesheet = StyleSheet.create((theme) => ({
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
