import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react-native";
import { ICON_SIZE } from "@/styles/theme";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";

const LONG_PRESS_MS = 450;
const POPUP_WIDTH = 208;
const POPUP_GAP = 6;
const EDGE_MARGIN = 8;

interface ToposUserMessageMenuProps {
  children: ReactNode;
  getContent: () => string;
  timestampLabel: string;
}

interface PopupAnchor {
  top: number;
  left: number;
}

/**
 * Topos-style user bubble menu: long-press the bubble to get a small popup with the
 * send time and a "copy text" action. Replaces the always-visible trailing row.
 */
export const ToposUserMessageMenu = memo(function ToposUserMessageMenu({
  children,
  getContent,
  timestampLabel,
}: ToposUserMessageMenuProps) {
  const { t } = useTranslation();
  const bubbleRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const handleLongPress = useCallback(() => {
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      // Right-align the popup with the bubble (user bubbles sit on the right), below it.
      const left = Math.max(EDGE_MARGIN, x + width - POPUP_WIDTH);
      setAnchor({ top: y + height + POPUP_GAP, left });
    });
  }, []);

  const handleClose = useCallback(() => {
    setAnchor(null);
    setCopied(false);
    setFailed(false);
  }, []);

  const handleCopy = useCallback(async () => {
    const content = getContent();
    if (!content) return;
    try {
      await writeMarkdownToRichClipboard(content, getDefaultMarkdownClipboardEnvironment());
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    setCopied(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      handleClose();
    }, 700);
  }, [getContent, handleClose]);

  let copyLabel = t("message.actions.copyText");
  if (copied) copyLabel = t("message.actions.copied");
  else if (failed) copyLabel = t("workspace.tabs.toasts.copyFailed");

  return (
    <>
      <Pressable
        ref={bubbleRef}
        onLongPress={handleLongPress}
        delayLongPress={LONG_PRESS_MS}
        accessibilityRole="button"
        accessibilityLabel={t("message.actions.copyText")}
        testID="topos-user-message-press"
      >
        {children}
      </Pressable>
      <Modal
        visible={anchor !== null}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <Pressable style={styles.backdrop} onPress={handleClose}>
          {anchor ? (
            <View style={[styles.popup, { top: anchor.top, left: anchor.left }]}>
              <Text style={styles.when} testID="topos-user-message-when">
                {timestampLabel}
              </Text>
              <Pressable
                onPress={handleCopy}
                style={styles.action}
                accessibilityRole="button"
                accessibilityLabel={t("message.actions.copyText")}
              >
                {({ pressed }) => (
                  <View style={[styles.actionInner, pressed ? styles.actionPressed : null]}>
                    {copied ? (
                      <Check size={ICON_SIZE.md} color={styles.icon.color} />
                    ) : (
                      <Copy size={ICON_SIZE.md} color={styles.icon.color} />
                    )}
                    <Text style={styles.actionText}>{copyLabel}</Text>
                  </View>
                )}
              </Pressable>
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
  },
  popup: {
    position: "absolute",
    width: POPUP_WIDTH,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.popover,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.md,
  },
  when: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  action: {
    borderRadius: theme.borderRadius.lg,
  },
  actionInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  actionPressed: {
    backgroundColor: theme.colors.surface3,
  },
  actionText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  icon: {
    color: theme.colors.foreground,
  },
}));
