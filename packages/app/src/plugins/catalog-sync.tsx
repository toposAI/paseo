import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const serverIds = useMemo(() => [serverId], [serverId]);
  // null = server info not received yet: not the same as "plugins unsupported".
  const availability = useHostFeatureAvailabilityMap(serverIds, "plugins").get(serverId) ?? null;
  const supported = availability === true;

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    if (!supported) {
      if (availability === false) {
        pluginRegistry.removeHost(serverId);
        pluginRegistry.setCatalogStatus(serverId, "unsupported");
      }
      return;
    }
    if (!audio) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    if (!connected) {
      // Keep the last catalog while the socket is down: dropping it made every open surface
      // claim "unavailable" until the catalog came back. The reconnect refresh replaces it.
      pluginRegistry.setCatalogStatus(serverId, "loading");
      return;
    }
    const refresh = (replacePluginId?: string) => {
      if (pluginRegistry.getCatalogStatus(serverId) !== "ready") {
        pluginRegistry.setCatalogStatus(serverId, "loading");
      }
      refreshQueue = refreshQueue.then(() =>
        client
          .getPluginCatalog()
          .then((catalog) => {
            if (!cancelled) {
              pluginRegistry.installCatalog(serverId, catalog, {
                replacePluginId,
                client,
                audio,
              });
            }
            return undefined;
          })
          .catch((error) => {
            if (!cancelled) {
              console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
              // A stale catalog stays usable; only an empty host is reported as failed.
              if (pluginRegistry.getCatalogStatus(serverId) === "loading") {
                pluginRegistry.setCatalogStatus(serverId, "failed");
              }
            }
            return undefined;
          }),
      );
      return refreshQueue;
    };
    const unregisterRetry = pluginRegistry.registerRetry(serverId, () => {
      pluginRegistry.setCatalogStatus(serverId, "loading");
      void refresh();
    });
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        void refresh();
      },
      update: (message) => {
        if (message.type !== "status") return;
        if (message.payload.status === "plugin_settings_changed") {
          const { pluginId, settingsId } = message.payload;
          if (typeof settingsId === "string") {
            const plugin = pluginRegistry
              .getSnapshot()
              .find((item) => item.serverId === serverId && item.id === pluginId);
            void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
          }
        }
        if (message.payload.status === "plugin_catalog_changed") {
          const pluginId = message.payload.pluginId;
          if (typeof pluginId === "string") void refresh(pluginId);
        }
      },
    });
    return () => {
      cancelled = true;
      unregisterRetry();
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [audio, availability, client, connected, serverId, supported]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
