import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { getDictation139Bridge, switchDictation139App } from "@/utils/dictation139-bridge";

// 139番アプリ内(JS橋あり)だけ「T」を出し、個人版Toposの画面へ切り替える。
// 置き場所はサイドバーの「新しいワークスペース」行の右端(`SidebarNewWorkspaceRow`)。
export function SwitchToToposButton() {
  if (!getDictation139Bridge()) return null;
  return (
    <Pressable
      style={styles.switchAppButton}
      onPress={switchDictation139App}
      testID="sidebar-switch-to-topos"
      accessible
      accessibilityRole="button"
      accessibilityLabel="Toposへ切り替え"
      hitSlop={8}
    >
      <Text style={styles.switchAppText}>T</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  switchAppButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  // ToposのPと同じ濃い色・太字。
  switchAppText: {
    color: theme.colors.foreground,
    fontWeight: "700",
    fontSize: 18,
  },
}));
