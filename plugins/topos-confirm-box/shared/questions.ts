/**
 * 承認待ちの `input.questions`(Claude の AskUserQuestion / opencode の question)を、
 * 確認箱のカードで「質問文 + 選択肢 + その他」として答えるための純粋関数。
 *
 * **クライアント(react-native)とサーバー(デーモン内サブプロセス)の両方が import する**ので、
 * React / Node のAPIは使わない。
 *
 * 回答の載せ方はプロバイダ共通ではないが、Paseo の
 * `AgentPermissionResponse.updatedInput.answers` が受け口になっている(すべて
 * `answers[キー]` を読む。キーは質問の header が共通解):
 * - claude:   `normalizeClaudeAskUserQuestionUpdatedInput` が header→質問文へ正規化する
 * - opencode v1: `answers[header]` を読んで `question.reply` に渡す(値はカンマで分割)
 * - opencode v2: `answers[header]` を読むが、**複数選択は配列を要求する**(文字列だと例外)
 * - codex / omp / pi(rpiv): header 引き。複数選択は「ラベル, ラベル」の連結を前提にする
 * したがってキーは **header**(空/重複なら質問文)を使う。
 *
 * 既知の残差: opencode v2 の複数選択だけは、プラグインから v1/v2 を区別できないため
 * 文字列で送ると上流で例外になる(画面にはエラーが出る。無言の成功にはならない)。
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
  /**
   * 上限を超えて切り詰めた/捨てた質問・選択肢があるか。
   * **切り詰めた文字列は回答値としては使えない**(上流の選択肢と一致しなくなる)ので、
   * 画面はフォームを出さず「スレで答えてください」に倒す。
   */
  truncated: boolean;
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

/**
 * 上限を超えたら切る。**切ったかどうかも返す**(切った文字列は回答値に使えないため、
 * 呼び出し側は `truncated` を立てて画面からフォームを引っ込める)。
 * 末尾に `…` を付けない: 付けると上流の選択肢ラベルと一致しなくなる。
 */
function clampText(value: string, max: number): { text: string; cut: boolean } {
  return value.length > max
    ? { text: value.slice(0, max), cut: true }
    : { text: value, cut: false };
}

interface ParsedOption {
  option: QuestionOption;
  cut: boolean;
}

/** 選択肢1件。`{label, description}` と文字列の両方を受ける。読めなければ null。 */
function parseOption(raw: unknown): ParsedOption | null {
  if (typeof raw === "string") {
    const label = raw.trim();
    if (!label) return null;
    const clamped = clampText(label, MAX_LABEL);
    return { option: { label: clamped.text, description: null }, cut: clamped.cut };
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const label = str(rec.label).trim();
  if (!label) return null;
  const clampedLabel = clampText(label, MAX_LABEL);
  const trimmedDescription = str(rec.description).trim();
  const clampedDescription = trimmedDescription
    ? clampText(trimmedDescription, MAX_DESCRIPTION)
    : { text: "", cut: false };
  return {
    option: {
      label: clampedLabel.text,
      description: clampedDescription.text || null,
    },
    cut: clampedLabel.cut,
  };
}

/** 質問1件。`question` が無い/空なら null(描いても答えられない)。 */
function parseQuestion(raw: unknown): QuestionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const question = str(q.question).trim();
  if (!question) return null;

  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const options: QuestionOption[] = [];
  let cut = rawOptions.length > MAX_OPTIONS;
  for (const entry of rawOptions) {
    const parsed = parseOption(entry);
    if (!parsed) {
      // 読めない選択肢を黙って落とすと「選べない選択肢」になる。切り詰め扱いにする。
      cut = true;
      continue;
    }
    if (parsed.cut) cut = true;
    options.push(parsed.option);
    if (options.length >= MAX_OPTIONS) break;
  }

  const clampedQuestion = clampText(question, MAX_QUESTION);
  const clampedHeader = clampText(str(q.header).trim(), MAX_LABEL);

  return {
    header: clampedHeader.text,
    question: clampedQuestion.text,
    truncated: cut || clampedQuestion.cut || clampedHeader.cut,
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
  let dropped = raw.length > MAX_QUESTIONS;
  for (const entry of raw) {
    const question = parseQuestion(entry);
    if (!question) {
      // 読めない質問を落とすと「未回答のまま許可」になりうる。全部フォーム不可へ倒す。
      dropped = true;
      continue;
    }
    out.push(question);
    if (out.length >= MAX_QUESTIONS) break;
  }
  if (out.length === 0) return null;
  // 1問でも落としたら、残りにも答えさせない(部分回答を上流へ流さない)。
  return dropped ? out.map((question) => ({ ...question, truncated: true })) : out;
}

/** 切り詰め/欠落があり、この画面からは答えられない質問を含むか。 */
export function anyTruncated(questions: readonly QuestionItem[]): boolean {
  // `=== true` ではなく `!== false` で見る: 古いサーバー(この欄を知らない版)から
  // 来た項目は undefined になる。その時は「答えられない」側へ倒す。
  return questions.some((question) => question.truncated !== false);
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

/**
 * 選択肢の表示キー。同じラベルの選択肢が2つあると React のキーが衝突し、
 * 片方を選ぶともう片方も選ばれたように見える。連番を足して一意にする
 * (回答値に使うのは `label` のままで、キーは表示の都合)。
 */
export function uniqueOptionKeys(options: readonly QuestionOption[]): string[] {
  const used = new Set<string>();
  return options.map((option) => {
    let key = option.label;
    let n = 1;
    // 付けた連番が既存のラベルと衝突しないまで進める(例: ["A","A","A #2"])。
    while (used.has(key)) {
      n += 1;
      key = `${option.label} #${n}`;
    }
    used.add(key);
    return key;
  });
}

/** 自由記述欄を出すか(選択肢が無い、または「その他」可)。 */
export function showsTextInput(question: QuestionItem): boolean {
  return question.options.length === 0 || question.allowOther;
}

/**
 * 画面の選択状態から見た「答えられるか」。
 * ワイヤ上の値に対する判定は `isAnsweredValue` と対で保守する(規則をずらさない)。
 */
export function isAnswered(
  question: QuestionItem,
  selected: readonly number[],
  otherText: string,
): boolean {
  if (selected.length > 0) return true;
  if (showsTextInput(question) && otherText.trim().length > 0) return true;
  // 空で通すのは、作った側が allowEmpty を明示した時だけ
  // (選択肢の有無は問わない。選択肢つきで allowEmpty の質問も実在する)。
  return question.allowEmpty;
}

/** サーバー側の判定。`isAnswered` と同じ規則を、送られてきた値に対して適用する。 */
export function isAnsweredValue(
  question: QuestionItem,
  value: string | undefined,
): value is string {
  return value !== undefined && (value.length > 0 || question.allowEmpty);
}

/** 選んだ選択肢と自由記述から `answers` を組み立てる。 */
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
    if (labels.length > 0) {
      answers[keys[i]] = labels.join(", ");
      return;
    }
    // 何も選ばずに空で通すのは、作った側が allowEmpty を明示した時だけ
    // (選択肢があるのに未選択なら、ここでは空を入れない=送信側の isAnswered で止まる)。
    if (q.allowEmpty) answers[keys[i]] = "";
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
 * - 長すぎる回答は**切らずに拒否する**(切った文字列は上流の選択肢と一致しない)
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
    const value = rawValue.trim();
    // **切らない**。切った文字列は上流の選択肢と一致せず、別の回答として解釈される
    // (選択肢の切り詰めを画面側で禁じているのと同じ理由)。
    if (value.length > MAX_ANSWER) {
      return {
        ok: false,
        message: `回答が長すぎます(${MAX_ANSWER}字まで)。スレで答えてください`,
      };
    }
    picked.set(index, value);
  }

  const out: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const value = picked.get(i);
    if (!isAnsweredValue(questions[i], value)) {
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
