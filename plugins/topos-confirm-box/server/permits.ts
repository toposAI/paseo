/**
 * Paseo 側の承認待ち(permit)を確認箱の項目へ変換する。
 *
 * 実物は `paseo.agents.list()` の `entries[].agent.pendingPermissions`
 * (`packages/protocol/src/messages.ts:830`)。**自前で状態を持たない**ので、
 * プラグインを再読込しても承認待ちが消えない(実行時に引く)。
 *
 * 別解として `~/.local/state/toposai/coordinator_wakeup_daemon/event_subscriber_permits.json`
 * があるが、あれは「受信箱へ通知済みのスレ一覧」であって生の承認待ちではない
 * (`antigravity/utils/paseo_event_subscriber.py` の `write_shared_permits()`)。**使わない。**
 *
 * ホストの型は import できないので、必要な形だけ構造的に書く
 * (渡ってくる実体は `AgentSnapshotPayload` / `AgentPermissionRequestPayload`)。
 */
import type { ConfirmBoxItem, ConfirmBoxOption } from "../shared/contract.js";
import { parseQuestions, questionsToText, sanitizeAnswers } from "../shared/questions.js";
import type { QuestionItem } from "../shared/questions.js";

export interface PermitActionLike {
  id?: unknown;
  label?: unknown;
  behavior?: unknown;
  variant?: unknown;
}

export interface PermitRequestLike {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
  actions?: unknown;
}

export interface PermitAgentLike {
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  workspaceId?: unknown;
  archivedAt?: unknown;
  updatedAt?: unknown;
  pendingPermissions?: unknown;
}

/** 選択肢の上限は箱側と同じ(store.ts `OPTIONS_MAX`)。 */
const OPTIONS_MAX = 6;
const SUBJECT_MAX = 200;
const SUMMARY_MAX = 400;
const BACKGROUND_MAX = 8000;

function s(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 承認待ちの選択肢。エージェント側が `actions` を出すならそれを使う
 * (許可の種類が複数あるプロバイダがあるため)。無ければ許可/拒否の2択。 */
export function permitOptions(perm: PermitRequestLike): {
  options: ConfirmBoxOption[];
  recommended: string | null;
} {
  const raw = Array.isArray(perm.actions) ? (perm.actions as PermitActionLike[]) : [];
  const options: ConfirmBoxOption[] = [];
  const seen = new Set<string>();
  let recommended: string | null = null;
  for (const a of raw) {
    const id = s(a.id).trim().slice(0, 40);
    const label = s(a.label).trim().slice(0, 120);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label });
    // 「主」の選択肢(variant=primary)を推奨として出す。押し付けではなく既定の提示。
    if (recommended === null && a.variant === "primary") recommended = id;
    if (options.length >= OPTIONS_MAX) break;
  }
  if (options.length === 0) {
    return {
      options: [
        { id: "__allow", label: "許可" },
        { id: "__deny", label: "拒否" },
      ],
      recommended: null,
    };
  }
  return { options, recommended };
}

/** `actions` の id から応答(behavior / selectedActionId)を組み立てる。 */
export function permitResponse(
  perm: PermitRequestLike,
  actionId: string | null,
): { behavior: "allow" | "deny"; selectedActionId?: string } {
  const raw = Array.isArray(perm.actions) ? (perm.actions as PermitActionLike[]) : [];
  const hit = actionId ? raw.find((a) => s(a.id) === actionId) : undefined;
  if (hit) {
    const behavior = hit.behavior === "deny" ? "deny" : "allow";
    return { behavior, selectedActionId: s(hit.id) };
  }
  // `actions` が無い/一致しない場合は自前の2択。`selectedActionId` は付けない
  // (存在しないidを送ると上流で弾かれる)。
  return { behavior: actionId === "__deny" ? "deny" : "allow" };
}

/** 承認対象の中身(実行コマンド・対象パス等)を1行で。`input` の形はツール次第なので既知キーだけ拾う。 */
export function inputGist(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "url", "pattern", "query"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 承認待ちが質問(AskUserQuestion / opencode の question)なら、その中身を返す。 */
export function permitQuestions(perm: PermitRequestLike): QuestionItem[] | null {
  const kind = s(perm.kind).trim();
  // kind を持つプロバイダは "question" の時だけ質問として扱う
  // (別ツールの input にたまたま questions があっても拾わない)。
  if (kind && kind !== "question") return null;
  return parseQuestions(perm.input);
}

/** 質問への回答を `updatedInput.answers` に載せた応答。上流の質問を実物で引き直して組み立てる。 */
export function questionResponse(
  perm: PermitRequestLike,
  answers: Record<string, string>,
):
  | { ok: true; response: { behavior: "allow"; updatedInput: Record<string, unknown> } }
  | { ok: false; message: string } {
  const questions = permitQuestions(perm);
  if (!questions) return { ok: false, message: "この承認待ちは質問ではありません" };
  const sanitized = sanitizeAnswers(questions, answers);
  if (!sanitized.ok) return { ok: false, message: sanitized.message };
  const input =
    perm.input && typeof perm.input === "object" && !Array.isArray(perm.input)
      ? (perm.input as Record<string, unknown>)
      : {};
  return {
    ok: true,
    response: { behavior: "allow", updatedInput: { ...input, answers: sanitized.answers } },
  };
}

/** プロバイダが付ける「質問」というだけの題名(opencode は title:"Question")。 */
const GENERIC_QUESTION_TITLES = new Set(["question", "askuserquestion", "質問"]);

function permitSubject(perm: PermitRequestLike, questions: QuestionItem[] | null): string {
  const title = s(perm.title).trim();
  const first = questions?.[0]?.question ?? "";
  if (first && (!title || GENERIC_QUESTION_TITLES.has(title.toLowerCase()))) {
    return first.slice(0, SUBJECT_MAX);
  }
  return (title || s(perm.description).trim() || s(perm.name).trim() || first || "承認待ち").slice(
    0,
    SUBJECT_MAX,
  );
}

function questionSummary(questions: QuestionItem[]): string {
  if (questions.length > 1) {
    const headers = questions.map((q) => q.header || q.question).join(" / ");
    return `${questions.length}問: ${headers}`.slice(0, SUMMARY_MAX);
  }
  const labels = questions[0].options.map((option) => option.label);
  return labels.length > 0 ? labels.join(" / ").slice(0, SUMMARY_MAX) : "自由記述で回答";
}

/** 背景欄。質問は生JSONではなく、質問文と選択肢がそのまま読める形にする。 */
function permitBackground(perm: PermitRequestLike, questions: QuestionItem[] | null): string {
  if (questions) return questionsToText(questions).slice(0, BACKGROUND_MAX);
  if (perm.input === undefined) return "";
  return safeJson(perm.input).slice(0, BACKGROUND_MAX);
}

function agentLabel(agent: PermitAgentLike): string {
  const id = s(agent.id);
  const title = s(agent.title).trim();
  const short = id.slice(0, 7);
  return title ? `${title}(${short})` : short || "unknown";
}

function tsOf(agent: PermitAgentLike, fallback: number): number {
  const raw = s(agent.updatedAt);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 承認待ちのエージェント一覧を確認箱の項目へ。**並べ替えは呼び出し側**(merge が行う)。 */
export function permitsToItems(
  agents: readonly PermitAgentLike[],
  now: number = Date.now(),
): ConfirmBoxItem[] {
  const items: ConfirmBoxItem[] = [];
  for (const agent of agents) {
    if (s(agent.archivedAt)) continue; // アーカイブ済みは出さない
    const agentId = s(agent.id);
    if (!agentId) continue;
    const perms = Array.isArray(agent.pendingPermissions)
      ? (agent.pendingPermissions as PermitRequestLike[])
      : [];
    for (const perm of perms) {
      const requestId = s(perm.id);
      if (!requestId) continue;
      const { options, recommended } = permitOptions(perm);
      // 質問は選択肢ボタン(許可/拒否)では答えられない。中身を画面へ渡し、
      // 背景も生JSONではなく読める形にする(質問文と選択肢がそのまま読める)。
      const questions = permitQuestions(perm);
      const subject = permitSubject(perm, questions);
      const gist = inputGist(perm.input);
      const head = s(perm.description).trim() || s(perm.name).trim() || subject;
      const summary = questions
        ? questionSummary(questions)
        : (gist && !head.includes(gist) ? `${head}: ${gist}` : head).slice(0, SUMMARY_MAX);
      const background = permitBackground(perm, questions);
      items.push({
        id: `permit:${agentId}:${requestId}`,
        kind: "permit",
        // 承認待ちはエージェントが止まっている = 最優先。
        priority: "blocking",
        subrank: 0,
        group: null,
        subject,
        summary,
        background,
        source: agentLabel(agent),
        threadRef: { kind: "paseo_agent", id: agentId },
        stoppedCount: 0,
        options,
        recommended,
        state: "new",
        urgency: "normal",
        key: null,
        agentId,
        workspaceId: s(agent.workspaceId) || null,
        ...(questions ? { questions } : {}),
        ts: tsOf(agent, now),
      });
    }
  }
  return items;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}
