import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

// Web-only: opens the OS photo picker via <input type=file> synchronously inside the tap
// (iOS drops the gesture across awaits, so no permission/pending-result round trips here).
export function pickWebImages(): Promise<PickedImageAttachmentInput[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length === 0) {
        resolve(null);
        return;
      }
      resolve(
        files.map((file) => ({
          source: { kind: "blob" as const, blob: file },
          mimeType: file.type || "image/jpeg",
          fileName: file.name || null,
        })),
      );
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
