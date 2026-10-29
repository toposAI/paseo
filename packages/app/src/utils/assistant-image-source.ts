import { localFileSourceToPath } from "@/attachments/utils";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";

export type AssistantImageSourceResolution =
  | { kind: "direct"; uri: string }
  | { kind: "remote"; url: string }
  | { kind: "file_rpc"; cwd: string; path: string };

export function resolveAssistantImageSource(input: {
  source: string;
  workspaceRoot?: string;
}): AssistantImageSourceResolution | null {
  const source = input.source.trim();
  if (!source) {
    return null;
  }

  // Remote images go through the daemon so the device never talks to third parties.
  if (/^https?:\/\//i.test(source)) {
    return { kind: "remote", url: source };
  }

  if (/^(data:|blob:)/i.test(source)) {
    return { kind: "direct", uri: source };
  }

  const readTarget = resolveFilePreviewReadTarget({
    path: localFileSourceToPath(source),
    workspaceRoot: input.workspaceRoot,
  });
  if (!readTarget) {
    return null;
  }

  return {
    kind: "file_rpc",
    cwd: readTarget.cwd,
    path: readTarget.path,
  };
}
