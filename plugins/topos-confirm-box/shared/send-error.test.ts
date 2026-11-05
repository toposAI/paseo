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
  it("日付や child-… のような名前は消さない", () => {
    expect(sendErrorNotice(new Error("期限 20261105 を過ぎています"))).toBe(
      "送れません: 期限 20261105 を過ぎています",
    );
    expect(sendErrorNotice(new Error("child-20261105-160752-6486 は閉じています"))).toBe(
      "送れません: child-20261105-160752-6486 は閉じています",
    );
  });
  it("8桁の短いIDは取り除く", () => {
    expect(sendErrorNotice(new Error("busy e7c1e629"))).toBe("送れません: busy");
  });
});
