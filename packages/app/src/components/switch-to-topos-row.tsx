import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { getDictation139Bridge, switchDictation139App } from "@/utils/dictation139-bridge";

// 139番アプリ内(JS橋あり)だけ「T」を出し、個人版Toposの画面へ切り替える。
// Topos側の「P」と同じ右上の角に置く。×は無い(サイドバーは項目選択・左スワイプで閉じる)。
export function SwitchToToposRow() {
  const isCompact = useIsCompactFormFactor();
  if (!getDictation139Bridge()) return null;
  return (
    <WindowChromeSafeArea
      placement="inline"
      pointerEvents="box-none"
      style={isCompact ? styles.switchAppButtonRowCompact : styles.switchAppButtonRow}
    >
      <Pressable
        style={isCompact ? styles.switchAppButtonCompact : styles.switchAppButton}
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
  // iPhone幅のToposは「P」が約6px低い位置にあるのでそろえる。
  switchAppButtonRowCompact: {
    marginTop: theme.spacing[2] + 6,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  switchAppButtonCompact: {
    // ToposのPと右端をそろえる(iPhone幅)。
    marginRight: theme.spacing[2] + 4,
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
  switchAppButton: {
    // ToposのPと右端をそろえる(PC幅)。
    marginRight: theme.spacing[2] - 1,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
}));
