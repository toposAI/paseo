import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useUnistyles } from "react-native-unistyles";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";

const MENU_WIDTH = 180;
const ITEM_HEIGHT = 36;
const EDGE = 8;

interface ToposUserMessageContextMenuProps {
  children: ReactNode;
  getContent: () => string;
  onResend: () => void;
}

interface MenuState {
  x: number;
  y: number;
  selected: string;
}

/**
 * Desktop: right-click anywhere on a sent prompt for a small menu with "copy" and "resend"
 * (resend puts the prompt back into the composer so a mistaken Enter can be redone).
 * `display: contents` keeps the wrapper out of the bubble's layout.
 */
export function ToposUserMessageContextMenu({
  children,
  getContent,
  onResend,
}: ToposUserMessageContextMenuProps) {
  const { theme } = useUnistyles();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const height = ITEM_HEIGHT * 2 + 8;
    setMenu({
      x: Math.max(EDGE, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - EDGE)),
      y: Math.max(EDGE, Math.min(event.clientY, window.innerHeight - height - EDGE)),
      selected: window.getSelection()?.toString() ?? "",
    });
  }, []);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const handleCopy = useCallback(() => {
    // A selection inside the prompt copies just that; otherwise the whole prompt.
    const text = menu?.selected.trim() ? menu.selected : getContent();
    setMenu(null);
    if (text) void writeMarkdownToRichClipboard(text, getDefaultMarkdownClipboardEnvironment());
  }, [getContent, menu]);
  const handleResend = useCallback(() => {
    setMenu(null);
    onResend();
  }, [onResend]);

  const colors = theme.colors;
  const item: CSSProperties = {
    display: "block",
    width: "100%",
    height: ITEM_HEIGHT,
    padding: "0 12px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: colors.foreground,
    fontSize: 14,
    textAlign: "left",
    cursor: "pointer",
  };
  // Stop the page's pointerdown-closes-menu listener from eating the click on an item.
  const keepOpenUntilClick = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <div style={{ display: "contents" }} onContextMenu={handleContextMenu}>
      {children}
      {menu
        ? createPortal(
            <div
              style={{
                position: "fixed",
                top: menu.y,
                left: menu.x,
                width: MENU_WIDTH,
                zIndex: 1100,
                padding: 4,
                background: colors.popover,
                color: colors.foreground,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
              }}
              data-testid="topos-user-message-context-menu"
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                style={item}
                onClick={handleCopy}
                onPointerDownCapture={keepOpenUntilClick}
                data-testid="topos-user-message-context-copy"
              >
                コピー
              </button>
              <button
                type="button"
                style={item}
                onClick={handleResend}
                onPointerDownCapture={keepOpenUntilClick}
                data-testid="topos-user-message-context-resend"
              >
                再送信(入力欄に戻す)
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
