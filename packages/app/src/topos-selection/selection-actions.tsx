interface ToposSelectionActionsProps {
  serverId: string;
  agentId: string;
}

// Web-only (see selection-actions.web.tsx); native keeps the OS selection menu.
export function ToposSelectionActions(_props: ToposSelectionActionsProps) {
  return null;
}
