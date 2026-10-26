import type { ReactNode } from "react";
import { ToposUserMessageContextMenu } from "@/components/topos-user-message-context-menu";
import { ToposUserMessageMenu } from "@/components/topos-user-message-menu";
import type { UserMessageMenuKind } from "@/components/user-message-chrome";

interface UserMessageBubbleFrameProps {
  menu: UserMessageMenuKind;
  getContent: () => string;
  timestampLabel: string;
  onResend: () => void;
  children: ReactNode;
}

/**
 * Wraps a user bubble in whichever menu the platform uses. `none` is deliberate for phone
 * browsers: a long-press wrapper renders as a `<button>`, and WebKit refuses to select text
 * inside buttons (see `resolveUserMessageChrome`).
 */
export function UserMessageBubbleFrame({
  menu,
  getContent,
  timestampLabel,
  onResend,
  children,
}: UserMessageBubbleFrameProps) {
  if (menu === "long-press") {
    return (
      <ToposUserMessageMenu getContent={getContent} timestampLabel={timestampLabel}>
        {children}
      </ToposUserMessageMenu>
    );
  }
  if (menu === "context-menu") {
    return (
      <ToposUserMessageContextMenu getContent={getContent} onResend={onResend}>
        {children}
      </ToposUserMessageContextMenu>
    );
  }
  return children;
}
