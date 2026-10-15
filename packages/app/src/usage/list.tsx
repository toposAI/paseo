import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import { moveReportInOrder, sortUsageReports } from "./model";
import type { UsageReportEntry } from "./types";

/**
 * One card per report (source + account), in a stable, user-arrangeable order. Window rows pin
 * while the sidebar summary is on.
 */
export function UsageList({
  serverId,
  reports,
  display,
}: {
  serverId: string;
  reports: UsageReportEntry[];
  display: UsageDisplay;
}) {
  const { inSidebar } = useUsageInSidebar();
  const sorted = useMemo(() => sortUsageReports(reports, display.order), [reports, display.order]);
  const shownIds = useMemo(() => sorted.map((entry) => entry.id), [sorted]);
  const { setOrder } = display;
  const move = useCallback(
    (reportId: string, step: -1 | 1) => setOrder(moveReportInOrder(shownIds, reportId, step)),
    [setOrder, shownIds],
  );
  return (
    <View style={styles.list}>
      {sorted.map((entry, index) => (
        <View key={entry.id} style={styles.row}>
          <View style={[settingsStyles.card, styles.card]}>
            <UsageCard
              serverId={serverId}
              entry={entry}
              display={display}
              pinnable={inSidebar}
              refreshable
            />
          </View>
          <ReorderButtons
            reportId={entry.id}
            canMoveUp={index > 0}
            canMoveDown={index < sorted.length - 1}
            onMove={move}
          />
        </View>
      ))}
    </View>
  );
}

function ReorderButtons({
  reportId,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  reportId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (reportId: string, step: -1 | 1) => void;
}) {
  const handleUp = useCallback(() => onMove(reportId, -1), [onMove, reportId]);
  const handleDown = useCallback(() => onMove(reportId, 1), [onMove, reportId]);
  return (
    <View style={styles.reorder}>
      <Pressable
        onPress={handleUp}
        disabled={!canMoveUp}
        hitSlop={6}
        style={canMoveUp ? styles.reorderButton : styles.reorderButtonDisabled}
        accessibilityRole="button"
        accessibilityLabel="Move up"
        testID={`usage-move-up-${reportId}`}
      >
        <ChevronUp size={ICON_SIZE.md} color={styles.icon.color} />
      </Pressable>
      <Pressable
        onPress={handleDown}
        disabled={!canMoveDown}
        hitSlop={6}
        style={canMoveDown ? styles.reorderButton : styles.reorderButtonDisabled}
        accessibilityRole="button"
        accessibilityLabel="Move down"
        testID={`usage-move-down-${reportId}`}
      >
        <ChevronDown size={ICON_SIZE.md} color={styles.icon.color} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  card: {
    flex: 1,
    minWidth: 0,
  },
  reorder: {
    flexShrink: 0,
    justifyContent: "center",
    gap: theme.spacing[1],
  },
  reorderButton: {
    padding: theme.spacing[1],
  },
  reorderButtonDisabled: {
    padding: theme.spacing[1],
    opacity: 0.25,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
}));
