/**
 * 承認待ちの `input.questions`(Claude の AskUserQuestion / opencode の question)を、
 * 確認箱のカードで「質問文 + 選択肢 + その他」として答えるための純粋関数。
 *
 * **クライアント(react-native)とサーバー(デーモン内サブプロセス)の両方が import する**ので、
 * React / Node のAPIは使わない。
 *
 * 回答の載せ方はプロバイダ共通ではないが、Paseo の
 * `AgentPermissionResponse.updatedInput.answers` が受け口になっている:
 * - opencode: `respondToPermission` が `answers[header]` を読んで `question.reply` に渡す
 * - claude:   `normalizeClaudeAskUserQuestionUpdatedInput` が header→質問文へ正規化する
 * したがってキーは **header**(空/重複なら質問文)を使う。
 */

export interface QuestionOption {
  label: string;
  description: string | null;
}

export interface QuestionItem {
  header: string;
  question: string;
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  options: QuestionOption[];
}

export type QuestionSelections = Record<number, readonly number[]>;
export type QuestionOtherTexts = Record<number, string>;

/** 画面が壊れるほど長い入力をそのまま描かないための上限(通常は4問×4択程度)。 */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const MAX_LABEL = 200;
const MAX_QUESTION = 500;
const MAX_DESCRIPTION = 400;
const MAX_ANSWER = 500;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clampText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 選択肢1件。`{label, description}` と文字列の両方を受ける。読めなければ null。 */
function parseOption(raw: unknown): QuestionOption | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    return label ? { label: clampText(label, MAX_LABEL), description: null } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const label = str(rec.label).trim();
  if (!label) return null;
  const description = str(rec.description).trim();
  return {
    label: clampText(label, MAX_LABEL),
    description: description ? clampText(description, MAX_DESCRIPTION) : null,
  };
}

/** 質問1件。`question` が無い/空なら null(描いても答えられない)。 */
function parseQuestion(raw: unknown): QuestionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const question = str(q.question).trim();
  if (!question) return null;

  const options: QuestionOption[] = [];
  for (const entry of Array.isArray(q.options) ? q.options : []) {
    const option = parseOption(entry);
    if (option) options.push(option);
    if (options.length >= MAX_OPTIONS) break;
  }

  return {
    header: clampText(str(q.header).trim(), MAX_LABEL),
    question: clampText(question, MAX_QUESTION),
    multiSelect: q.multiSelect === true || q.multiple === true,
    // 選択肢が無い質問は自由記述しかない。Claude は allowOther を付けてくる。
    allowOther: q.allowOther === true || q.isOther === true || options.length === 0,
    allowEmpty: q.allowEmpty === true,
    options,
  };
}

/**
 * `input`(または `input.questions`)から質問だけ取り出す。質問が無ければ `null`。
 * `options` は `{label, description}` の配列が基本だが、文字列の配列も受ける。
 */
export function parseQuestions(input: unknown): QuestionItem[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return null;

  const out: QuestionItem[] = [];
  for (const entry of raw) {
    const question = parseQuestion(entry);
    if (question) out.push(question);
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out.length > 0 ? out : null;
}

/** `answers` のキー。header が空/重複なら質問文で代用する。 */
export function answerKeys(questions: readonly QuestionItem[]): string[] {
  const used = new Set<string>();
  return questions.map((q) => {
    let key = q.header.trim() || q.question;
    if (used.has(key)) key = q.question;
    if (used.has(key)) key = `${q.question} (${used.size + 1})`;
    used.add(key);
    return key;
  });
}

/** 自由記述欄を出すか(選択肢が無い、または「その他」可)。 */
export function showsTextInput(question: QuestionItem): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isAnswered(
  question: QuestionItem,
  selected: readonly number[],
  otherText: string,
): boolean {
  if (selected.length > 0) return true;
  if (showsTextInput(question) && otherText.trim().length > 0) return true;
  // 選択肢が無い質問を空で通すのは、作った側が allowEmpty を明示した時だけ。
  return question.allowEmpty && question.options.length === 0;
}

/** 選んだ選択肢と自由記述から `answers` を組み立てる(コアPWAの質問カードと同じ規則)。 */
export function buildAnswers(
  questions: readonly QuestionItem[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, string> {
  const keys = answerKeys(questions);
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const picked = selections[i] ?? [];
    const labels = picked
      .map((index) => q.options[index]?.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0);
    const other = (otherTexts[i] ?? "").trim();

    if (showsTextInput(q) && other) {
      // 複数選択ではチェックした選択肢に自由記述を足す(Claude Code の UI と同じ)。
      answers[keys[i]] = q.multiSelect ? [...labels, other].join(", ") : other;
      return;
    }
    if (q.allowEmpty && q.options.length === 0) {
      answers[keys[i]] = "";
      return;
    }
    if (labels.length > 0) answers[keys[i]] = labels.join(", ");
  });
  return answers;
}

export function allAnswered(
  questions: readonly QuestionItem[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions.length > 0 &&
    questions.every((q, i) => isAnswered(q, selections[i] ?? [], otherTexts[i] ?? ""))
  );
}

/**
 * サーバー側の受け口。**クライアントの言い分をそのまま上流へ流さない**:
 * - キーは実物の質問に一致するものだけ(知らないキーは捨てずにエラー)
 * - 全質問に回答が揃っていること(欠けたまま allow すると、上流では無回答の許可になる)
 * - 長さを切る
 */
export function sanitizeAnswers(
  questions: readonly QuestionItem[],
  answers: Record<string, string>,
): { ok: true; answers: Record<string, string> } | { ok: false; message: string } {
  const keys = answerKeys(questions);
  const alias = new Map<string, number>();
  questions.forEach((q, i) => {
    alias.set(keys[i], i);
    if (q.header) alias.set(q.header, i);
    alias.set(q.question, i);
  });

  const picked = new Map<number, string>();
  for (const [rawKey, rawValue] of Object.entries(answers)) {
    const index = alias.get(rawKey.trim());
    if (index === undefined) {
      return { ok: false, message: `知らない質問への回答です: ${rawKey.slice(0, 60)}` };
    }
    if (typeof rawValue !== "string") {
      return { ok: false, message: "回答は文字列で送ってください" };
    }
    picked.set(index, rawValue.trim().slice(0, MAX_ANSWER));
  }

  const out: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const value = picked.get(i);
    if (value === undefined) {
      return {
        ok: false,
        message: `未回答の質問があります: ${questions[i].question.slice(0, 60)}`,
      };
    }
    out[keys[i]] = value;
  }
  return { ok: true, answers: out };
}

/** 背景欄に出す読みやすい形(生JSONの代わり)。 */
export function questionsToText(questions: readonly QuestionItem[]): string {
  return questions
    .map((q) => {
      const lines = [q.header ? `[${q.header}] ${q.question}` : q.question];
      for (const option of q.options) {
        lines.push(`  ・${option.label}${option.description ? ` — ${option.description}` : ""}`);
      }
      const notes: string[] = [];
      if (q.multiSelect) notes.push("複数選択可");
      if (showsTextInput(q)) notes.push("その他の自由記述可");
      if (notes.length > 0) lines.push(`  (${notes.join(" / ")})`);
      return lines.join("\n");
    })
    .join("\n\n");
}
