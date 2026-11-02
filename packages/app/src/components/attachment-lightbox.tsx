import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Modal, Platform, Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, ChevronRight, Send, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import type { ViewportSize, ViewportSwipeDirection } from "@/components/zoomable-viewport/geometry";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useAssistantImage } from "@/assistant-image/use-assistant-image";
import { useGlobalWebOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";

export type ImageLightboxSource =
  | { type: "attachment"; metadata: AttachmentMetadata }
  | { type: "uri"; uri: string; contentSize?: ViewportSize }
  | {
      type: "assistant";
      source: string;
      occurrenceKey: string;
      client?: DaemonClient | null;
      workspaceRoot?: string;
      serverId?: string;
    };

/** Steps through the images of one chat; `source` is the one currently shown. */
export interface LightboxGallery {
  /** Identifies the shown image, so a half-typed comment stays with its own image. */
  imageKey: string;
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}

export interface LightboxComment {
  onSubmit: (text: string) => Promise<void>;
}

interface AttachmentLightboxProps {
  source: ImageLightboxSource | null;
  onClose: () => void;
  gallery?: LightboxGallery;
  comment?: LightboxComment;
}

const ModalRoot = isNative ? GestureHandlerRootView : View;
const LIGHTBOX_FIT = { padding: SPACING[4], maxWidth: 960, maxHeight: 640 };
// Phones open the image as large as the screen allows, not capped like a desktop window.
const LIGHTBOX_FIT_COMPACT = { padding: SPACING[2] };
const KEYBOARD_MIN_SHRINK_PX = 80;

/**
 * How much of the bottom of the screen the software keyboard covers. iOS Safari keeps the layout
 * viewport full height and only shrinks the visual viewport, so a fixed overlay has to read it.
 */
function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setInset(0);
      return undefined;
    }
    if (isWeb) {
      const viewport = typeof window === "undefined" ? null : window.visualViewport;
      if (!viewport) return undefined;
      const update = () => {
        const covered = window.innerHeight - viewport.height - viewport.offsetTop;
        setInset(covered > KEYBOARD_MIN_SHRINK_PX ? Math.round(covered) : 0);
      };
      update();
      viewport.addEventListener("resize", update);
      viewport.addEventListener("scroll", update);
      return () => {
        viewport.removeEventListener("resize", update);
        viewport.removeEventListener("scroll", update);
      };
    }
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (event) => setInset(event.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [enabled]);
  return inset;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || element?.isContentEditable === true;
}

interface LightboxImageViewProps {
  url: string | null;
  contentSize?: ViewportSize;
  failed?: boolean;
  onClose: () => void;
  onSwipe?: (direction: ViewportSwipeDirection) => void;
}

/** Shows one resolved image. Keyed by the caller so the error state follows the image. */
function LightboxImageView({ url, contentSize, failed, onClose, onSwipe }: LightboxImageViewProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [url]);
  const actions = useMemo(
    () => [
      {
        icon: X,
        label: t("message.attachments.closeImage"),
        onPress: onClose,
        testID: "attachment-lightbox-close",
      },
    ],
    [onClose, t],
  );
  const handleImageError = useCallback(() => setErrored(true), []);

  if (failed || errored || !url) {
    return <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>;
  }
  return (
    <ZoomableImage
      accessibilityLabel={t("composer.attachments.openImage")}
      actions={actions}
      contentSize={contentSize}
      fit={isCompact ? LIGHTBOX_FIT_COMPACT : LIGHTBOX_FIT}
      onError={handleImageError}
      onPressOutsideContent={onClose}
      onSwipe={onSwipe}
      alwaysShowControls
      style={styles.imageViewport}
      testID="attachment-lightbox"
      uri={url}
    />
  );
}

function AttachmentSourceImage({
  metadata,
  ...rest
}: { metadata: AttachmentMetadata } & Omit<LightboxImageViewProps, "url" | "contentSize">) {
  const url = useAttachmentPreviewUrl(metadata);
  return <LightboxImageView url={url} {...rest} />;
}

function AssistantSourceImage({
  source,
  ...rest
}: {
  source: Extract<ImageLightboxSource, { type: "assistant" }>;
} & Omit<LightboxImageViewProps, "url" | "contentSize">) {
  const image = useAssistantImage({
    source: source.source,
    occurrenceKey: source.occurrenceKey,
    client: source.client,
    workspaceRoot: source.workspaceRoot,
    serverId: source.serverId,
  });
  const aspectRatio = image.status === "failed" ? undefined : image.aspectRatio;
  const contentSize = useMemo(
    () => (aspectRatio ? { width: aspectRatio, height: 1 } : undefined),
    [aspectRatio],
  );
  if (image.status === "failed") return <LightboxImageView url={null} failed {...rest} />;
  const url = image.binding?.uri ?? null;
  if (!url) {
    return <ActivityIndicator style={styles.loading} testID="attachment-lightbox-loading" />;
  }
  return <LightboxImageView url={url} contentSize={contentSize} {...rest} />;
}

function LightboxSourceImage({
  source,
  ...rest
}: { source: ImageLightboxSource } & Omit<LightboxImageViewProps, "url" | "contentSize">) {
  if (source.type === "attachment") {
    return <AttachmentSourceImage metadata={source.metadata} {...rest} />;
  }
  if (source.type === "assistant") {
    return <AssistantSourceImage source={source} {...rest} />;
  }
  return <LightboxImageView url={source.uri} contentSize={source.contentSize} {...rest} />;
}

function GalleryControls({
  gallery,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  gallery: LightboxGallery;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.counter} testID="attachment-lightbox-counter">
        {t("message.attachments.imageCounter", {
          current: gallery.index + 1,
          total: gallery.total,
        })}
      </Text>
      {hasPrevious ? (
        <Pressable
          accessibilityLabel={t("message.attachments.previousImage")}
          accessibilityRole="button"
          onPress={onPrevious}
          style={styles.stepPrevious}
          testID="attachment-lightbox-previous"
        >
          <ChevronLeft size={22} color={styles.stepIcon.color} />
        </Pressable>
      ) : null}
      {hasNext ? (
        <Pressable
          accessibilityLabel={t("message.attachments.nextImage")}
          accessibilityRole="button"
          onPress={onNext}
          style={styles.stepNext}
          testID="attachment-lightbox-next"
        >
          <ChevronRight size={22} color={styles.stepIcon.color} />
        </Pressable>
      ) : null}
    </>
  );
}

type CommentStatus = "idle" | "sending" | "failed";

function LightboxCommentBar({
  imageKey,
  comment,
  bottomInset,
}: {
  imageKey: string;
  comment: LightboxComment;
  bottomInset: number;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<CommentStatus>("idle");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const sendingRef = useRef(false);
  const draft = drafts[imageKey] ?? "";
  const canSend = draft.trim().length > 0 && status !== "sending";

  useEffect(() => {
    setStatus("idle");
  }, [imageKey]);

  const handleChange = useCallback(
    (text: string) => setDrafts((current) => ({ ...current, [imageKey]: text })),
    [imageKey],
  );
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    // A ref, not `status`: two taps in one frame both see the stale "idle" state.
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    setStatus("sending");
    try {
      await comment.onSubmit(text);
      setDrafts((current) => ({ ...current, [imageKey]: "" }));
      inputRef.current?.reset();
      setStatus("idle");
    } catch (error) {
      console.warn("[chat-image-viewer] comment failed", error);
      setStatus("failed");
    } finally {
      sendingRef.current = false;
    }
  }, [comment, draft, imageKey]);
  const barStyle = useMemo(
    () => [styles.commentBar, bottomInset > 0 ? { marginBottom: bottomInset } : null],
    [bottomInset],
  );
  const sendButtonStyle = useMemo(
    () => [styles.sendButton, !canSend ? styles.sendButtonDisabled : null],
    [canSend],
  );

  return (
    <View style={barStyle} testID="attachment-lightbox-comment-bar">
      {status === "failed" ? (
        <Text style={styles.commentError} testID="attachment-lightbox-comment-error">
          {t("message.attachments.imageCommentFailed")}
        </Text>
      ) : null}
      <View style={styles.commentRow}>
        <EditingTextInput
          key={imageKey}
          ref={inputRef}
          initialValue={draft}
          accessibilityLabel={t("message.attachments.imageCommentPlaceholder")}
          editable={status !== "sending"}
          onChangeText={handleChange}
          onSubmitEditing={handleSend}
          placeholder={t("message.attachments.imageCommentPlaceholder")}
          placeholderTextColor={styles.placeholder.color}
          returnKeyType="send"
          style={styles.commentInput}
          testID="attachment-lightbox-comment-input"
        />
        <Pressable
          accessibilityLabel={t("message.attachments.sendImageComment")}
          accessibilityRole="button"
          disabled={!canSend}
          onPress={handleSend}
          style={sendButtonStyle}
          testID="attachment-lightbox-comment-send"
        >
          {status === "sending" ? (
            <ActivityIndicator size="small" />
          ) : (
            <Send size={18} color={styles.sendIcon.color} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

export function AttachmentLightbox({ source, onClose, gallery, comment }: AttachmentLightboxProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && source !== null);
  const keyboardInset = useKeyboardInset(source !== null && comment !== undefined);

  const hasPrevious = gallery !== undefined && gallery.index > 0;
  const hasNext = gallery !== undefined && gallery.index < gallery.total - 1;
  const onPrevious = gallery?.onPrevious;
  const onNext = gallery?.onNext;
  const goPrevious = useCallback(() => {
    if (hasPrevious) onPrevious?.();
  }, [hasPrevious, onPrevious]);
  const goNext = useCallback(() => {
    if (hasNext) onNext?.();
  }, [hasNext, onNext]);
  const handleSwipe = useCallback(
    (direction: ViewportSwipeDirection) => {
      if (direction === "next") goNext();
      else goPrevious();
    },
    [goNext, goPrevious],
  );

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }
      if (!gallery || isTextEntryTarget(event.target)) return false;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowLeft") goPrevious();
        else goNext();
        return true;
      }
      return false;
    },
    [gallery, goNext, goPrevious, onClose],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && source !== null,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const contentLayerStyle = useMemo(
    () => [
      styles.contentLayer,
      {
        paddingTop: insets.top,
        paddingRight: insets.right,
        paddingBottom: keyboardInset > 0 ? 0 : insets.bottom,
        paddingLeft: insets.left,
      },
    ],
    [insets.bottom, insets.left, insets.right, insets.top, keyboardInset],
  );

  if (!source) {
    return null;
  }

  const imageKey = gallery?.imageKey ?? "single";

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <ModalRoot style={styles.root}>
        <WindowChromeRootRegion corners="both">
          <View ref={setWebOverlayScope} style={styles.root}>
            <Pressable
              testID="attachment-lightbox-backdrop"
              accessibilityRole="button"
              accessibilityLabel={t("message.attachments.dismissImage")}
              onPress={onClose}
              style={styles.backdrop}
            />
            <View pointerEvents="box-none" style={contentLayerStyle}>
              <View pointerEvents="box-none" style={styles.imageArea}>
                <LightboxSourceImage
                  key={imageKey}
                  source={source}
                  onClose={onClose}
                  onSwipe={gallery ? handleSwipe : undefined}
                />
                {gallery && gallery.total > 1 ? (
                  <GalleryControls
                    gallery={gallery}
                    hasPrevious={hasPrevious}
                    hasNext={hasNext}
                    onPrevious={goPrevious}
                    onNext={goNext}
                  />
                ) : null}
              </View>
              {comment ? (
                <LightboxCommentBar
                  imageKey={imageKey}
                  comment={comment}
                  bottomInset={keyboardInset}
                />
              ) : null}
            </View>
          </View>
        </WindowChromeRootRegion>
      </ModalRoot>
    </Modal>
  );
}

const STEP_BUTTON_SIZE = 40;

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  imageArea: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  imageViewport: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
  },
  loading: {
    alignSelf: "center",
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  counter: {
    position: "absolute",
    top: theme.spacing[3],
    left: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0,0,0,0.55)",
    color: "#fff",
    fontSize: theme.fontSize.sm,
    overflow: "hidden",
  },
  stepPrevious: {
    position: "absolute",
    left: theme.spacing[2],
    top: "50%",
    marginTop: -STEP_BUTTON_SIZE / 2,
    width: STEP_BUTTON_SIZE,
    height: STEP_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  stepNext: {
    position: "absolute",
    right: theme.spacing[2],
    top: "50%",
    marginTop: -STEP_BUTTON_SIZE / 2,
    width: STEP_BUTTON_SIZE,
    height: STEP_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  stepIcon: {
    color: "#fff",
  },
  commentBar: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  commentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 640,
    width: "100%",
    alignSelf: "center",
  },
  commentInput: {
    flex: 1,
    minWidth: 0,
    height: 44,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    // 16px keeps iOS Safari from zooming the page when the field is focused.
    fontSize: 16,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  sendIcon: {
    color: theme.colors.foreground,
  },
  commentError: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
