/**
 * チャットペインの「届いたか分かる」表示用の状態。
 *
 * 送信直後は `sent`(送信済み)。以降は相手スレの購読から取れた事実だけで進める:
 * - timeline の `reasoning` → thinking(考え中)
 * - timeline の `compaction`(status=loading) → compacting(コンテキスト圧縮中)、completed で解除
 * - timeline の `tool_call*` → working(ツール実行中)
 * - timeline の `assistant_message` → replying(返信中)
 * - エージェント状態が running 以外になったら解除(idle/終了)
 * 取れない情報は推測で出さない(例: running だが項目がまだ無い間は、新しい状態へ進めず `sent` のまま)。
 */
export type PaneActivity = "sent" | "thinking" | "compacting" | "working" | "replying";

export type PaneActivityEvent =
  | { kind: "sent" }
  | { kind: "item"; itemType: string | undefined; status?: string }
  | { kind: "agent-status"; status: string | undefined }
  | { kind: "reset" };

export function nextPaneActivity(
  cur: PaneActivity | null,
  ev: PaneActivityEvent,
): PaneActivity | null {
  switch (ev.kind) {
    case "sent":
      return "sent";
    case "reset":
      return null;
    case "agent-status":
      // running 以外=手が止まった。ただし送信済みは、送信前の古い idle 通知で消えないよう残す
      // (相手の反応=項目が来るまで「送信済み」は事実として正しい)。
      if (ev.status === "running") return cur;
      return cur === "sent" ? cur : null;
    case "item": {
      const t = ev.itemType ?? "";
      if (t === "reasoning") return "thinking";
      if (t === "compaction") return ev.status === "loading" ? "compacting" : "thinking";
      if (t.startsWith("tool_call")) return "working";
      if (t === "assistant_message") return "replying";
      return cur;
    }
    default:
      return cur;
  }
}

export const PANE_ACTIVITY_LABEL: Record<PaneActivity, string> = {
  sent: "✓ 送信済み(相手スレの反応を待っています)",
  thinking: "考え中…",
  compacting: "コンテキストを圧縮中…",
  working: "ツールを実行中…",
  replying: "返信中…",
};
