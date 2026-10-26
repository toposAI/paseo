import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Marks where the reader stopped last time: the first turn they had not read sits below this
 * line when a chat is reopened at its last read position.
 */
export function UnreadDivider() {
  const { t } = useTranslation();
  return (
    <View style={unreadDividerStylesheet.container} testID="agent-stream-unread-divider">
      <View style={unreadDividerStylesheet.rule} />
      <Text style={unreadDividerStylesheet.label}>{t("agentStream.unreadFromHere")}</Text>
      <View style={unreadDividerStylesheet.rule} />
    </View>
  );
}

const unreadDividerStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rule: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
