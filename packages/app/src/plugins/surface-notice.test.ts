import { expect, test } from "vitest";
import { resolveSurfaceNoticeKind } from "./surface-notice";

const none = { plugin: null, surface: null };

test("unavailable is shown only once the catalog is ready", () => {
  expect(resolveSurfaceNoticeKind({ ...none, catalogStatus: "idle" })).toBe("loading");
  expect(resolveSurfaceNoticeKind({ ...none, catalogStatus: "loading" })).toBe("loading");
  expect(resolveSurfaceNoticeKind({ ...none, catalogStatus: "failed" })).toBe("failed");
  expect(resolveSurfaceNoticeKind({ ...none, catalogStatus: "ready" })).toBe("unavailable");
  expect(resolveSurfaceNoticeKind({ ...none, catalogStatus: "unsupported" })).toBe("unavailable");
});

test("an installed plugin without a client reads as offline", () => {
  expect(
    resolveSurfaceNoticeKind({
      plugin: {},
      surface: {},
      catalogStatus: "loading",
    }),
  ).toBe("offline");
});
