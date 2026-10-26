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
  const container = resolveCopyContainer();
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
  }
}

export function resolveCopyContainer(
  active: Element | null = typeof document === "undefined" ? null : document.activeElement,
  body: HTMLElement = document.body,
): HTMLElement {
  const parent = active?.parentElement;
  if (!parent || active === body || parent === document.documentElement) {
    return body;
  }
  return parent;
}
