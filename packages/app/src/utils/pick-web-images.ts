import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

// Web-only: opens the OS photo picker via a persistent <input type=file> (same shape as the Topos
// m.html photo-input: attached once, reused, clicked synchronously inside the tap).
let sharedInput: HTMLInputElement | null = null;
let pendingResolve: ((files: PickedImageAttachmentInput[] | null) => void) | null = null;

function getInput(): HTMLInputElement {
  if (sharedInput && sharedInput.isConnected) return sharedInput;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.(
      files.length === 0
        ? null
        : files.map((file) => ({
            source: { kind: "blob" as const, blob: file },
            mimeType: file.type || "image/jpeg",
            fileName: file.name || null,
          })),
    );
  });
  input.addEventListener("cancel", () => {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.(null);
  });
  document.body.appendChild(input);
  sharedInput = input;
  return input;
}

export function pickWebImages(): Promise<PickedImageAttachmentInput[] | null> {
  return new Promise((resolve) => {
    pendingResolve?.(null);
    pendingResolve = resolve;
    getInput().click();
  });
}
