import { describe, expect, it } from "vitest";
import { foldUserMessage, RELAY_FOLD_MIN_CHARS } from "./user-message-fold";

const LONG_BODY = `[F-80司令塔→完了箱C・表示のみ] F-80を完成させる計画
${"計画の本文をここに書く。".repeat(10)}`;
const ONE_LINE_REPORT = "#29 /Users/user/.local/state/toposai/progress_window/reports/29.md";
// What F-80's stale CLI actually delivered: no envelope, so no sender is recorded.
const PLAIN_DIRECT_SEND = LONG_BODY;
const ENVELOPED = `<paseo-system version="1" kind="agent-message" source-agent-id="afe8d176-0000-4000-8000-000000000000" message-id="m1" source-agent-title="F-80司令塔">\n${LONG_BODY}\n</paseo-system>`;

const RELAY = {
  agentTitle: "完了箱C",
  relayFolding: "relay",
  titleMark: "完了箱C",
} as const;

describe("foldUserMessage", () => {
  it("folds a long direct send in the relay thread even without an envelope", () => {
    const fold = foldUserMessage({ ...RELAY, text: PLAIN_DIRECT_SEND });
    expect(fold.kind).toBe("folded");
    if (fold.kind !== "folded") return;
    expect(fold.sender).toBeNull();
    expect(fold.preview.startsWith("[F-80司令塔→完了箱C・表示のみ]")).toBe(true);
  });

  it("names the sender of an enveloped agent message", () => {
    const fold = foldUserMessage({ ...RELAY, text: ENVELOPED });
    expect(fold).toMatchObject({ kind: "folded", sender: "F-80司令塔" });
  });

  it("keeps the one-line protocol report whole", () => {
    expect(foldUserMessage({ ...RELAY, text: ONE_LINE_REPORT })).toEqual({ kind: "full" });
  });

  it("keeps short messages and the reader's comments whole", () => {
    expect(foldUserMessage({ ...RELAY, text: "ありがとう、いいね" })).toEqual({ kind: "full" });
    const justBelow = `いいね ${"あ".repeat(RELAY_FOLD_MIN_CHARS - 1 - "いいね ".length)}`;
    expect(justBelow.trim()).toHaveLength(RELAY_FOLD_MIN_CHARS - 1);
    expect(foldUserMessage({ ...RELAY, text: justBelow })).toEqual({ kind: "full" });
  });

  it("keeps a short multi-line message: length decides, not line breaks", () => {
    const shortLines = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    expect(foldUserMessage({ ...RELAY, text: shortLines })).toEqual({ kind: "full" });
  });

  it("leaves other threads alone", () => {
    expect(foldUserMessage({ ...RELAY, agentTitle: "窓口B", text: PLAIN_DIRECT_SEND })).toEqual({
      kind: "full",
    });
    expect(foldUserMessage({ ...RELAY, agentTitle: null, text: PLAIN_DIRECT_SEND })).toEqual({
      kind: "full",
    });
  });

  it("is switched off by the setting or an empty title mark", () => {
    expect(foldUserMessage({ ...RELAY, relayFolding: "off", text: PLAIN_DIRECT_SEND })).toEqual({
      kind: "full",
    });
    expect(foldUserMessage({ ...RELAY, titleMark: "", text: PLAIN_DIRECT_SEND })).toEqual({
      kind: "full",
    });
  });

  it("never hides an image the reader attached", () => {
    expect(foldUserMessage({ ...RELAY, hasMedia: true, text: PLAIN_DIRECT_SEND })).toEqual({
      kind: "full",
    });
  });

  it("leaves harness-only turns to the harness row", () => {
    const harnessTurn = `<system-reminder>${"x".repeat(200)}</system-reminder>`;
    expect(foldUserMessage({ ...RELAY, text: harnessTurn })).toEqual({ kind: "full" });
  });

  it("keeps what the reader typed themselves whole", () => {
    expect(foldUserMessage({ ...RELAY, isOwnSend: true, text: PLAIN_DIRECT_SEND })).toEqual({
      kind: "full",
    });
  });

  it("only folds the relay thread itself, not threads that talk about it", () => {
    expect(
      foldUserMessage({ ...RELAY, agentTitle: "完了箱Cの畳み修正", text: PLAIN_DIRECT_SEND }),
    ).toEqual({ kind: "full" });
  });

  it("folds a relay title that carries a suffix only when allowed", () => {
    const suffixed = { ...RELAY, agentTitle: "完了箱C (2)", text: PLAIN_DIRECT_SEND };
    expect(foldUserMessage(suffixed)).toEqual({ kind: "full" });
    expect(foldUserMessage({ ...suffixed, relayFolding: "suffix" }).kind).toBe("folded");
  });

  it("counts characters, not UTF-16 units, for the threshold", () => {
    const emoji = "😀".repeat(RELAY_FOLD_MIN_CHARS);
    expect(Array.from(emoji)).toHaveLength(RELAY_FOLD_MIN_CHARS);
    expect(foldUserMessage({ ...RELAY, text: emoji }).kind).toBe("folded");
  });

  it("shows the body of an envelope without a sender", () => {
    const fold = foldUserMessage({
      ...RELAY,
      text: `<paseo-system>\n${LONG_BODY}\n</paseo-system>`,
    });
    expect(fold).toMatchObject({ kind: "folded", sender: null });
    if (fold.kind === "folded") expect(fold.preview.startsWith("[F-80司令塔")).toBe(true);
  });

  it("truncates a very long first line", () => {
    const fold = foldUserMessage({ ...RELAY, text: "あ".repeat(300) });
    expect(fold.kind).toBe("folded");
    if (fold.kind === "folded") expect(Array.from(fold.preview).length).toBe(81);
  });
});
