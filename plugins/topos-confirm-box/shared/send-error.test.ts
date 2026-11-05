import { describe, expect, it } from "vitest";
import { sendErrorNotice } from "./send-error.js";

describe("sendErrorNotice", () => {
  it("Agent not found は日本語にしてIDを出さない", () => {
    const m = sendErrorNotice(new Error("Agent not found: e7c1e629-1111-4222-8333-444455556666"));
    expect(m).toBe("送れません: 宛先のスレが見つかりません");
  });
  it("他の理由からも16進のIDを取り除く", () => {
    const m = sendErrorNotice(new Error("timeout for e7c1e629-1111-4222-8333-444455556666"));
    expect(m).not.toMatch(/[0-9a-f]{8}/);
  });
});
