import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

// Web-only: opens the OS camera via <input capture> and resolves with the shot, or null if cancelled.
export function captureCameraImage(): Promise<
  PickedImageAttachmentInput[] | null
> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      resolve([
        {
          source: { kind: "blob", blob: file },
          mimeType: file.type || "image/jpeg",
          fileName: file.name || "camera.jpg",
        },
      ]);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
