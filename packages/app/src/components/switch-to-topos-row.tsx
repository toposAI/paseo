import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { getDictation139Bridge, switchDictation139App } from "@/utils/dictation139-bridge";

// 139番アプリ内(JS橋あり)だけ「T」を出し、個人版Toposの画面へ切り替える。
// Topos側の「P」と同じ右上の角に置く。×は無い(サイドバーは項目選択・左スワイプで閉じる)。
export function SwitchToToposRow() {
  if (!getDictation139Bridge()) return null;
  return (
    <WindowChromeSafeArea
      placement="inline"
      pointerEvents="box-none"
      style={styles.switchAppButtonRow}
    >
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
    </WindowChromeSafeArea>
  );
}

const styles = StyleSheet.create((theme) => ({
  switchAppButtonRow: {
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  switchAppText: {
    color: theme.colors.foregroundMuted,
    fontWeight: "700",
    fontSize: 16,
  },
  switchAppButton: {
    // Same right rail as the footer Settings glyph (the 16px glyph paints inside its 32px target).
    marginRight: theme.spacing[2] + 1.5,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
}));
