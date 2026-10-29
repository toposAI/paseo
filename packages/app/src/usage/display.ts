import { useCallback, useEffect, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
import {
  isUsagePinned,
  rememberLastGood,
  resolveLastGood,
  setUsageDisplayAs,
  setUsageOrder,
  toggleUsagePin,
  type UsageDisplayAs,
  type UsagePin,
  type UsagePreferences,
} from "./preferences";
import type { UsageReportEntry } from "./types";

/** What usage views need from the preferences: how to read percents, and the pins. */
export interface UsageDisplay {
  displayAs: UsageDisplayAs;
  setDisplayAs: (displayAs: UsageDisplayAs) => void;
  isPinned: (pin: UsagePin) => boolean;
  togglePin: (pin: UsagePin) => void;
  order: readonly string[] | undefined;
  setOrder: (order: string[]) => void;
}

interface UsagePreferencesState {
  preferences: UsagePreferences;
  display: UsageDisplay;
}

/** The device's usage preferences, with pins resolved against a host's reports. */
export function useUsagePreferences(serverId?: string): UsagePreferencesState {
  const defaultServerId = useUsageHostId();
  const hostId = serverId ?? defaultServerId;
  return useUsageDisplay(useUsageHostReports(hostId), hostId);
}

/**
 * The device's usage preferences, with pins resolved against the given reports. With a `serverId`,
 * the reports are that host's, and its last good numbers are kept on the device for the sidebar to
 * show while it cannot answer.
 */
export function useUsageDisplay(
  reports: readonly UsageReportEntry[],
  serverId: string | null = null,
): UsagePreferencesState {
  const { settings, updateSettings } = useAppSettings();
  const preferences = settings.usage;
  // Keep the last good numbers so the sidebar can still show them once a source cannot answer.
  // The host is the one picked on the device while the sidebar's host is momentarily unknown, so a
  // report that fails mid-reconnect is still kept. Checked before saving: an empty patch would
  // still write the settings back to storage.
  const keepHost = serverId ?? preferences.serverId;
  useEffect(() => {
    if (keepHost === null) return;
    if (rememberLastGood(preferences, keepHost, reports) === preferences) return;
    void updateSettings((current) => {
      const usage = rememberLastGood(current.usage, keepHost, reports);
      return usage === current.usage ? {} : { usage };
    }).catch(() => undefined);
  }, [preferences, reports, keepHost, updateSettings]);
  const setDisplayAs = useCallback(
    (displayAs: UsageDisplayAs) => {
      void updateSettings((current) => ({ usage: setUsageDisplayAs(current.usage, displayAs) }));
    },
    [updateSettings],
  );
  const togglePin = useCallback(
    (pin: UsagePin) => {
      void updateSettings((current) => ({
        usage: toggleUsagePin({
          preferences: current.usage,
          pin,
          reports,
          lastGood: resolveLastGood(current.usage, serverId),
        }),
      }));
    },
    [serverId, updateSettings, reports],
  );
  const setOrder = useCallback(
    (order: string[]) => {
      void updateSettings((current) => ({ usage: setUsageOrder(current.usage, order) }));
    },
    [updateSettings],
  );
  const display = useMemo<UsageDisplay>(
    () => ({
      displayAs: preferences.displayAs,
      setDisplayAs,
      isPinned: (pin) =>
        isUsagePinned(preferences, pin, reports, resolveLastGood(preferences, serverId)),
      togglePin,
      order: preferences.order,
      setOrder,
    }),
    [preferences, reports, serverId, setDisplayAs, togglePin, setOrder],
  );
  return { preferences, display };
}
