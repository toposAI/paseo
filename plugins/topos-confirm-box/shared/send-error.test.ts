import { afterEach, describe, expect, it, vi } from "vitest";
import { SEND_FAILED_NOTICE, sendErrorNotice } from "./send-error.js";

describe("sendErrorNotice", () => {
  afterEach(() => vi.restoreAllMocks());

  it("理由が何であっても同じ文言で、IDを画面に出さない", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of [
      "Agent not found: e7c1e629-1111-4222-8333-444455556666",
      "timeout for e7c1e629",
      "child-20261105-160752-6486 は閉じています",
    ]) {
      expect(sendErrorNotice(new Error(raw))).toBe(SEND_FAILED_NOTICE);
    }
    expect(SEND_FAILED_NOTICE).not.toMatch(/[0-9a-f]{8}/);
  });

  it("詳しい理由はログに残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendErrorNotice(new Error("Agent not found: e7c1e629"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Agent not found: e7c1e629"));
  });

  it("Error以外の値でも落ちない", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sendErrorNotice("boom")).toBe(SEND_FAILED_NOTICE);
  });
});
