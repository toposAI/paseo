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
 *
 * 2026-10-27: 購読は接続直後に**過去の**書き込みまで `tool_call` として届ける。スレの状態を見ずに
 * 全部を「実行中」にすると、送信もしていないのに「ツールを実行中…」が出て、手が止まっても戻らなかった
 * (本番で9分止まり)。そこで作業系の項目(`tool_call`/`reasoning`)は**スレが running と分かった後だけ**
 * 進め、止まった(idle 等)なら送信済み以外は消す。
 */
export type PaneActivity = "sent" | "thinking" | "compacting" | "working" | "replying";

/**
 * 内部の状態。画面に出す5つに加えて、次の2つの印を持つ:
 * - `running` … スレが running だと分かったが、まだ項目が無い(出すものは無い)
 * - `sent-running` … 送信済みで、スレが running だと分かった(次の項目は「今の作業」として進める)
 */
export type PaneActivityState = PaneActivity | "running" | "sent-running";
/** 画面に出す値。印(`running`)は何も出さない(`null`)。送信済みは出したままにする。 */
export function paneActivityLabel(state: PaneActivityState | null): PaneActivity | null {
  if (state === "running") return null;
  if (state === "sent-running") return "sent";
  return state;
}

export type PaneActivityEvent =
  | { kind: "sent" }
  | { kind: "item"; itemType: string | undefined; status?: string }
  | { kind: "agent-status"; status: string | undefined }
  | { kind: "reset" };

export function nextPaneActivity(
  cur: PaneActivityState | null,
  ev: PaneActivityEvent,
): PaneActivityState | null {
  switch (ev.kind) {
    case "sent":
      return "sent";
    case "reset":
      return null;
    case "agent-status":
      // running 以外=手が止まった。送信済みだけは、「送ったのに相手は反応していない」という事実なので残す。
      if (ev.status === "running") {
        if (cur === "sent") return "sent-running";
        if (cur === "sent-running") return cur;
        return "running";
      }
      if (cur === "sent") return cur;
      if (cur === "sent-running") return "sent";
      return null;
    case "item": {
      const t = ev.itemType ?? "";
      // 過去の書き込みか今の作業かはスレの状態で判る。止まっている間(null/`sent`)は作業系を進めず、
      // 送信後に届いた返信だけは見せる。
      const settled = cur === null || cur === "sent";
      if (t === "assistant_message") return "replying";
      if (settled && (t === "reasoning" || t.startsWith("tool_call"))) return cur;
      if (t === "reasoning") return "thinking";
      if (t === "compaction") return ev.status === "loading" ? "compacting" : "thinking";
      if (t.startsWith("tool_call")) return "working";
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
