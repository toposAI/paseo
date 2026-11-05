import type { PluginCatalogStatus } from "./registry";

export type SurfaceNoticeKind = "loading" | "failed" | "offline" | "unavailable";

/** "Not fetched yet" must never read as "does not exist": only a ready catalog can say that. */
export function resolveSurfaceNoticeKind(input: {
  plugin: unknown;
  surface: unknown;
  catalogStatus: PluginCatalogStatus;
}): SurfaceNoticeKind {
  if (input.plugin && input.surface) return "offline";
  if (input.catalogStatus === "idle" || input.catalogStatus === "loading") return "loading";
  if (input.catalogStatus === "failed") return "failed";
  return "unavailable";
}
