/**
 * Plain-text copy that works in insecure-context iOS webviews (http Paseo over Tailscale).
 * `navigator.clipboard` is missing there, and Expo's fallback only calls `select()` (a no-op on iOS)
 * and reports success even when `execCommand("copy")` returns false.
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
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
  }
}
