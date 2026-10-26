/**
 * Plain-text copy that works in insecure-context iOS webviews (http Paseo over Tailscale).
 * `navigator.clipboard` is missing there, and Expo's fallback only calls `select()` (a no-op on iOS)
 * and reports success even when `execCommand("copy")` returns false.
 *
 * Inside a react-native-web Modal (e.g. the long-press menu) a textarea appended to `document.body`
 * is bounced back out by the modal's focus trap, which drops the selection and makes the copy a
 * no-op. The field therefore goes next to the currently focused element, i.e. inside the trap.
 */
export async function copyPlainTextWeb(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Denied by focus or policy: fall through to the selection-based path.
    }
  }
  if (!execCommandCopy(text)) {
    throw new Error("Clipboard copy failed");
  }
}

function execCommandCopy(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.contentEditable = "true";
  field.readOnly = false;
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  field.style.fontSize = "16px";
  const previouslyFocused = document.activeElement;
  const container = resolveCopyContainer(previouslyFocused);
  container.appendChild(field);
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    container.removeChild(field);
    if (previouslyFocused && previouslyFocused !== document.body) {
      (previouslyFocused as HTMLElement).focus?.();
    }
  }
}

const NON_CONTAINER_TAGS = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT"]);

/**
 * Inside a modal the focused element is inside the focus trap, so the field goes into it (or next
 * to it when it cannot hold children). Anywhere else, or with nothing focused, it goes to the body.
 */
export function resolveCopyContainer(
  active: Element | null = typeof document === "undefined" ? null : document.activeElement,
  body: HTMLElement = document.body,
): HTMLElement {
  if (!active || active === body || active === document.documentElement) {
    return body;
  }
  if (!NON_CONTAINER_TAGS.has(active.tagName)) {
    return active as HTMLElement;
  }
  const parent = active.parentElement;
  return parent && parent !== document.documentElement ? parent : body;
}
