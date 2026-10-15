import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";
import { deriveEffectiveWorkspaceStatus } from "./sidebar-workspaces-view-model";

export interface ToposSidebarCounts {
  ask: number;
  fresh: number;
}

// Packed into one primitive so the selector result is stable under Object.is.
function selectCountsKey(state: ReturnType<typeof useSessionStore.getState>): string {
  let ask = 0;
  let fresh = 0;
  for (const [serverId, session] of Object.entries(state.sessions)) {
    if (!session) continue;
    for (const workspace of session.workspaces.values()) {
      if (workspace.archivingAt) continue;
      const { status } = deriveEffectiveWorkspaceStatus({
        serverId,
        workspace,
        workspaceAgentActivity: session.workspaceAgentActivity,
      });
      if (status === "needs_input") ask += 1;
      else if (status === "attention") fresh += 1;
    }
  }
  return `${ask}:${fresh}`;
}

/** Orange (waiting on you) and green (new result) thread counts across all hosts. */
export function useToposSidebarCounts(): ToposSidebarCounts {
  const key = useStoreWithEqualityFn(useSessionStore, selectCountsKey, Object.is);
  const [ask, fresh] = key.split(":").map(Number);
  return { ask: ask ?? 0, fresh: fresh ?? 0 };
}
