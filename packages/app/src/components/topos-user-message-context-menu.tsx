import type { ReactNode } from "react";

interface ToposUserMessageContextMenuProps {
  children: ReactNode;
  getContent: () => string;
  onResend: () => void;
}

// Web-only (see topos-user-message-context-menu.web.tsx); native keeps the long-press menu.
export function ToposUserMessageContextMenu({ children }: ToposUserMessageContextMenuProps) {
  return <>{children}</>;
}
