/**
 * 判断カードを機械がそのまま画面へ出す試作のサーバー側(2026-11-01)。
 *
 * ここは **判断の中身を決めない**。次の1問を選ぶのも、点検を通ったカードかを見るのも、記録するのも
 * 既存の `judgment_window.py`(`next` / `finish`)1か所に任せ、この試作は
 *   1. `next` の返したカードをタイムライン行としてスレへ貼る
 *   2. 行のボタンの回答を `finish` へ渡し、返ってきた次のカードをまた貼る
 * だけを行う。**本文はモデルの返答にもスクリプトの標準出力にも出さない**。
 *
 * 二重記録を防ぐための機械の門(条件4)はこのファイルに閉じている:
 *   PAUSED / 古い行(stale) / 押し直し(duplicate) / 本文が変わった(changed)。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  CARD_DIRECT_KIND,
  CARD_DIRECT_VERSION,
  type CardDirectOption,
} from "../shared/card-direct.js";

const DEFAULT_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const DEFAULT_CLI_DIR = path.join(os.homedir(), "repos", "ToposAI-Mini-Project");
const CLI_TIMEOUT_MS = 60_000;

export interface JudgmentCli {
  python: string;
  script: string;
}

/** 判断窓口の CLI を解決する(無ければ null = 出題しない)。 */
export function resolveJudgmentCli(env: NodeJS.ProcessEnv = process.env): JudgmentCli | null {
  const dir = env.TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR?.trim() || DEFAULT_CLI_DIR;
  const script = path.join(path.resolve(dir), "antigravity", "utils", "judgment_window.py");
  if (!fs.existsSync(script)) return null;
  return { python: env.TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON?.trim() || DEFAULT_PYTHON, script };
}

/** 判断状態の置き場(検証では一時コピーを指す)。 */
export function judgmentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOPOS_JUDGMENT_WINDOW_DIR?.trim();
  return override
    ? path.resolve(override.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), ".local", "state", "toposai", "judgment_window");
}

/** 出題の一時停止の印があるか(`next` も同じ印を見るが、押下側でも先に見る)。 */
export function isPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(path.join(judgmentStateDir(env), "PAUSED.json"));
}

/** 出力のうち最後の JSON 行(警告行が混ざっても壊れない)。 */
function lastJsonLine(stdout: string): string {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith("{")) return line;
  }
  return "";
}

/** CLI を1回呼び、最後の JSON 行を返す(警告が混ざっても壊れない)。 */
export function runJudgmentCli(
  cli: JudgmentCli,
  args: readonly string[],
  input?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cli.python,
      [cli.script, ...args],
      {
        cwd: path.dirname(cli.script),
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        const line = lastJsonLine(`${stdout}`);
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        if (parsed) {
          resolve(parsed);
          return;
        }
        reject(
          new Error(
            `judgment_window.py ${args[0]} の結果を読めません: ${(error as Error | null)?.message ?? ""} ${`${stderr}`.slice(-300)}`,
          ),
        );
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

/** JSON を返さない副命令(`release` は "ok" と出すだけ)用。終了コードだけ見る。 */
function runJudgmentExit(
  cli: JudgmentCli,
  args: readonly string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cli.python,
      [cli.script, ...args],
      { cwd: path.dirname(cli.script), timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, _stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error(`${(error as Error).message} ${`${stderr}`.slice(-300)}`));
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stderr: `${stderr}` });
      },
    );
  });
}

// ---------------------------------------------------------------- 行の状態(二重記録よけ)

interface AgentRowState {
  cardId: string;
  window: string;
  shownAt: number;
  /** 出したときのカードファイルの指紋(本文が作り直されたら変わる)。 */
  cardSha: string;
  /** 行に載せた選択肢(押された id の見出しを逐語の回答にするため)。 */
  options: CardDirectOption[];
  answered: Record<string, { recorded: string; choiceId: string; at: number }>;
  /** 「保留」で手放した件(回答ではないので answered とは別に持つ)。 */
  held?: string[];
  /** 差し替えで止めた行(押しても記録しない)。直近だけ残す。 */
  retired?: string[];
}

const RETIRED_KEEP = 20;

interface RowStateFile {
  agents: Record<string, AgentRowState>;
}

function stateFile(stateDir: string): string {
  return path.join(stateDir, "card_direct_rows.json");
}

export function readRowState(stateDir: string): RowStateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(stateDir), "utf8")) as RowStateFile;
    if (raw && typeof raw === "object" && raw.agents && typeof raw.agents === "object") return raw;
  } catch {
    // 無い・壊れている=まだ出していない
  }
  return { agents: {} };
}

function writeRowState(stateDir: string, state: RowStateFile): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${stateFile(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile(stateDir));
}

function cardPath(stateDir: string, cardId: string): string {
  return path.join(stateDir, "cards", `${cardId}.json`);
}

/** カードファイルの指紋。読めなければ空(比べられない=弾く)。 */
function cardSha(stateDir: string, cardId: string): string {
  try {
    return createHash("sha1")
      .update(fs.readFileSync(cardPath(stateDir, cardId)))
      .digest("hex");
  } catch {
    return "";
  }
}

function asOptions(raw: unknown): CardDirectOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({
      id: String(o.id ?? ""),
      label: String(o.label ?? ""),
      description: String(o.description ?? ""),
    }))
    .filter((o) => o.id);
}

// ---------------------------------------------------------------- 出題

export interface ShowResult {
  shown: boolean;
  cardId: string;
  reason: string;
  questionChars: number;
  optionCount: number;
}

export interface ShowDeps {
  paseo: PaseoApi;
  cli: JudgmentCli | null;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}

/** 行をスレへ貼る(カード全文をデータに持たせる)。 */
export async function appendCardRow(
  deps: ShowDeps,
  agentId: string,
  window: string,
  card: Record<string, unknown>,
): Promise<string> {
  const cardId = String(card.id ?? "");
  const question = String(card.question ?? "");
  const options = asOptions(card.options);
  const shownAt = Date.now();
  const ref = deps.paseo.agents.ref(agentId);
  // デーモンを起動した直後はまだスレを読み終えておらず `Unknown agent` で1回落ちる(検証で実測)。
  // 既存の操作(アーカイブ等)と同じく、先に状態を取り直してから貼る。取れなくても貼りには進む。
  try {
    await ref.refresh();
  } catch {
    // 読めないだけなら貼りを試す(本当に無いスレなら下の append が理由を返す)
  }
  await ref.timeline.append({
    type: "plugin",
    // 同じカードを出し直しても行を足せるよう、出した時刻を id に入れる
    id: `card-direct-${cardId}-${shownAt}`,
    kind: CARD_DIRECT_KIND,
    version: CARD_DIRECT_VERSION,
    data: {
      cardId,
      window,
      question,
      options,
      recommended: String(card.recommended ?? ""),
      shownAt,
    },
  });
  const state = readRowState(deps.stateDir);
  const prev = state.agents[agentId];
  state.agents[agentId] = {
    cardId,
    window,
    shownAt,
    cardSha: cardSha(deps.stateDir, cardId),
    options,
    // 同じスレの過去の回答履歴は残す(押し直しの判定に使う)
    answered: prev?.answered ?? {},
    held: prev?.held ?? [],
    retired: prev?.retired ?? [],
  };
  writeRowState(deps.stateDir, state);
  return cardId;
}

/** 行を「もう押せない」印にする(差し替え・カード消失)。件そのものは触らない。 */
function retireRow(stateDir: string, agentId: string, cardId: string): void {
  if (!cardId) return;
  const state = readRowState(stateDir);
  const row = state.agents[agentId];
  if (!row || !row.cardId) return;
  const retired = (row.retired ?? []).filter((id) => id !== cardId);
  retired.push(cardId);
  row.retired = retired.slice(-RETIRED_KEEP);
  writeRowState(stateDir, state);
}

/**
 * `next` / `finish` の返す1件を取り出す。形が2通りある(実測):
 * - `next` が出せたとき … 件そのもの(`{id, card, has_card, card_note, ...}`)
 * - `finish` のあと・出せないとき … `{status, next: 件 | null, blocked, say}`
 */
function pickItem(out: Record<string, unknown>): Record<string, unknown> | null {
  const nested = out.next;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return out;
}

/** 次の1問を出す。出せないときは理由だけ返す(本文は返さない)。 */
export async function showNext(
  deps: ShowDeps,
  agentId: string,
  window: string,
): Promise<ShowResult> {
  const env = deps.env ?? process.env;
  if (!deps.cli)
    return {
      shown: false,
      cardId: "",
      reason: "judgment_cli_missing",
      questionChars: 0,
      optionCount: 0,
    };
  if (isPaused(env))
    return { shown: false, cardId: "", reason: "paused", questionChars: 0, optionCount: 0 };
  let out: Record<string, unknown>;
  try {
    out = await runJudgmentCli(deps.cli, ["next", "--window", window]);
  } catch (error) {
    return {
      shown: false,
      cardId: "",
      reason: `next_failed: ${(error as Error).message}`.slice(0, 300),
      questionChars: 0,
      optionCount: 0,
    };
  }
  if (out.paused)
    return { shown: false, cardId: "", reason: "paused", questionChars: 0, optionCount: 0 };
  const item = pickItem(out) ?? {};
  const card = item.card as Record<string, unknown> | null | undefined;
  if (!item.has_card || !card || typeof card !== "object") {
    // 点検を通ったカードが無い件は `next` が has_card=false で返す(この試作は質問を作らない)
    return {
      shown: false,
      cardId: "",
      reason: String(item.card_note ?? out.say ?? "no_card").slice(0, 300),
      questionChars: 0,
      optionCount: 0,
    };
  }
  const cardId = await appendCardRow(deps, agentId, window, card);
  return {
    shown: true,
    cardId,
    reason: "",
    questionChars: String(card.question ?? "").length,
    optionCount: asOptions(card.options).length,
  };
}

// ---------------------------------------------------------------- 回答

export interface AnswerInput {
  agentId: string;
  cardId: string;
  choiceId: string;
  answer: string;
}

export interface AnswerResult {
  ok: boolean;
  recorded: string;
  reason: string;
  nextCardId: string;
  shownNext: boolean;
}

/** 記録できた/既に記録済みのどちらでも、この行はもう答え済みとして扱う(連打で増やさない)。 */
function markAnswered(stateDir: string, input: AnswerInput, recorded: string): void {
  const after = readRowState(stateDir);
  const row = after.agents[input.agentId];
  if (!row || row.cardId !== input.cardId) return;
  row.answered[input.cardId] = { recorded, choiceId: input.choiceId, at: Date.now() };
  writeRowState(stateDir, after);
}

export async function answerCard(deps: ShowDeps, input: AnswerInput): Promise<AnswerResult> {
  const env = deps.env ?? process.env;
  const fail = (reason: string): AnswerResult => ({
    ok: false,
    recorded: "",
    reason,
    nextCardId: "",
    shownNext: false,
  });
  // 門1: 出題停止の印(本物の PAUSED.json は外さない。外すのは人が判断する)
  if (isPaused(env)) return fail("paused");
  const state = readRowState(deps.stateDir);
  const row = state.agents[input.agentId];
  // 門2: いま出している行ではない(古い行・別スレの行)
  if (!row || row.cardId !== input.cardId) return fail("stale");
  // 門3: 押し直し(連打・二度押し)
  if (row.answered[input.cardId])
    return { ...fail("duplicate"), recorded: row.answered[input.cardId].recorded };
  // 門4: カードの本文が作り直された
  const sha = cardSha(deps.stateDir, input.cardId);
  if (!sha || sha !== row.cardSha) return fail("changed");

  const option = row.options.find((o) => o.id === input.choiceId);
  const answer = (input.answer || option?.label || "").trim();
  if (!answer) return fail("empty_answer");
  if (!deps.cli) return fail("judgment_cli_missing");

  // 記録は `finish` に任せる(記録の条件・二重記録よけは Python 側が持つ)
  let out: Record<string, unknown>;
  try {
    out = await runJudgmentCli(
      deps.cli,
      ["finish", "--window", row.window, "--id", input.cardId, "--chosen", input.choiceId],
      answer,
    );
  } catch (error) {
    return fail(`finish_failed: ${(error as Error).message}`.slice(0, 300));
  }
  const recorded = String(out.status ?? "");
  markAnswered(deps.stateDir, input, recorded);

  // 次の1問(`finish` は次の件+カードを返す)。出せないときは何も貼らない
  const nextItem = pickItem(out) ?? {};
  const nextCard = nextItem.card as Record<string, unknown> | null | undefined;
  if (nextItem.has_card && nextCard && typeof nextCard === "object") {
    const nextCardId = await appendCardRow(deps, input.agentId, row.window, nextCard);
    return { ok: true, recorded, reason: "", nextCardId, shownNext: true };
  }
  return { ok: true, recorded, reason: "", nextCardId: "", shownNext: false };
}

// ---------------------------------------------------------------- 保留(release)

export interface HoldResult {
  ok: boolean;
  reason: string;
  nextCardId: string;
  shownNext: boolean;
}

/**
 * 「保留」= この1問を記録せずに手放し、次の1問へ進む。
 *
 * `release --dismissed`(=質問を閉じられた扱いで次へ進む)を使う。単なる `release` だと件が
 * すぐ空きに戻り、直後の `next` が同じ質問を返して「保留」が見かけ上なにもしない。
 * `--dismissed` は件を open のまま残し、他に出せる件があるあいだ後ろへ回す。
 */
export async function holdCard(
  deps: ShowDeps,
  input: { agentId: string; cardId: string },
): Promise<HoldResult> {
  const env = deps.env ?? process.env;
  const fail = (reason: string): HoldResult => ({
    ok: false,
    reason,
    nextCardId: "",
    shownNext: false,
  });
  if (isPaused(env)) return fail("paused");
  if (!deps.cli) return fail("judgment_cli_missing");
  const state = readRowState(deps.stateDir);
  const row = state.agents[input.agentId];
  if (!row || row.cardId !== input.cardId) return fail("stale");
  if (row.answered[input.cardId]) return fail("duplicate");
  if (row.held?.includes(input.cardId)) return fail("duplicate");

  try {
    const res = await runJudgmentExit(deps.cli, [
      "release",
      "--window",
      row.window,
      "--id",
      input.cardId,
      "--dismissed",
    ]);
    // 4 = この窓口の有効な印ではない(期限切れ・別の窓口が持っている)
    if (res.code !== 0) return fail(res.code === 4 ? "stale" : `release_failed: exit ${res.code}`);
  } catch (error) {
    return fail(`release_failed: ${(error as Error).message}`.slice(0, 300));
  }
  const after = readRowState(deps.stateDir);
  const held = after.agents[input.agentId];
  if (held && held.cardId === input.cardId) {
    held.held = [...(held.held ?? []).filter((id) => id !== input.cardId), input.cardId];
    writeRowState(deps.stateDir, after);
  }
  // 保留した1問の代わりに、次の1問があれば出す
  const next = await showNext(deps, input.agentId, row.window);
  return { ok: true, reason: "", nextCardId: next.cardId, shownNext: next.shown };
}

// ---------------------------------------------------------------- 自動出題(モデルを呼ばない)

/**
 * 窓口Aのスレ id。`windows/A.id`(判断窓口が使っている正本)を読み、検証では環境変数で差し替える。
 * どちらも無ければ空(=自動出題しない)。
 */
export function resolveWindowAgent(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = judgmentStateDir(env),
): string {
  const override = env.TOPOS_CARD_DIRECT_AGENT_A?.trim();
  if (override) return override;
  try {
    const lines = fs
      .readFileSync(path.join(stateDir, "windows", "A.id"), "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim());
    return lines.find((l) => /^[0-9a-f][0-9a-f-]{7,}$/i.test(l)) ?? "";
  } catch {
    return "";
  }
}

export interface AutoAskResult {
  shown: boolean;
  cardId: string;
  reason: string;
  retired: string;
}

function noShow(reason: string, retired = ""): AutoAskResult {
  return { shown: false, cardId: "", reason, retired };
}

/** まだ答えていない(保留にもしていない)表示中の行。 */
function openRowOf(row: AgentRowState | undefined): AgentRowState | undefined {
  if (!row || !row.cardId) return undefined;
  if (row.answered[row.cardId]) return undefined;
  if ((row.held ?? []).includes(row.cardId)) return undefined;
  return row;
}

/**
 * 1回ぶんの自動出題(2026-11-01 ユーザー「自動で次の質問スタンバイしてほしい」)。
 *
 * モデルは呼ばない。`judgment_window.py next` を叩き、返ったカードをそのまま行にするだけ。
 * **未回答の行が生きているあいだは新しい行を出さない**(常に1問)。出した行の件は `next` が
 * 自分の印として返し続けるので、呼ぶたびに期限が延びる(=話しかけなくても質問が消えない)。
 */
export async function autoAskOnce(deps: ShowDeps, agentId = ""): Promise<AutoAskResult> {
  const env = deps.env ?? process.env;
  const target = agentId || resolveWindowAgent(env, deps.stateDir);
  if (!target) return noShow("no_agent");
  if (!deps.cli) return noShow("judgment_cli_missing");
  // 門1: 出題停止の印(本物の PAUSED.json は外さない)
  if (isPaused(env)) return noShow("paused");

  const openRow = openRowOf(readRowState(deps.stateDir).agents[target]);
  let out: Record<string, unknown>;
  try {
    out = await runJudgmentCli(deps.cli, ["next", "--window", "A"]);
  } catch (error) {
    return noShow(`next_failed: ${(error as Error).message}`.slice(0, 300));
  }
  return showFromNext(deps, target, openRow, out);
}

/** `next` の返り値をそのまま行にする(出さないときは理由だけ)。 */
async function showFromNext(
  deps: ShowDeps,
  target: string,
  openRow: AgentRowState | undefined,
  out: Record<string, unknown>,
): Promise<AutoAskResult> {
  if (out.paused) return noShow("paused");
  const item = pickItem(out) ?? {};
  const card = item.card as Record<string, unknown> | null | undefined;
  if (!item.has_card || !card || typeof card !== "object") {
    // カードが無い(点検の印が切れた・作り直し中・出せる件が無い)。表示中の行は押せなくする
    if (!openRow) return noShow(String(item.card_note ?? out.say ?? "no_card").slice(0, 300));
    retireRow(deps.stateDir, target, openRow.cardId);
    return noShow("card_missing", openRow.cardId);
  }
  const cardId = String(card.id ?? "");
  const sha = cardSha(deps.stateDir, cardId);
  // すでに同じ本文の行が出ている=何もしない(`next` が印の期限を延ばしている)
  if (openRow && openRow.cardId === cardId && openRow.cardSha === sha) return noShow("");
  const retired = openRow?.cardId ?? "";
  if (retired) retireRow(deps.stateDir, target, retired);
  const shownId = await appendCardRow(deps, target, String(item.window ?? "A"), card);
  return { shown: true, cardId: shownId, reason: "", retired };
}

export interface AutoAskHandle {
  /** いま走っているか(試験用)。 */
  running(): boolean;
  stop(): void;
}

/**
 * 自動出題を一定間隔で回す。プラグインのサーバーが読み込まれた時点で始め、
 * 片付け(プラグインの reload・デーモンの終了)で止める。
 *
 * 出す時点は「回答の直後・出せるカードができた時・PAUSED が外れた時・再起動の後」のどれも
 * 「次の見回り」で拾う(専用のイベントは無い。`next` は何度呼んでも同じ1問を返す)。
 */
export function startAutoAsk(deps: ShowDeps, intervalMs = 20_000): AutoAskHandle {
  let busy = false;
  let stopped = false;
  const tick = (): void => {
    if (busy || stopped) return;
    busy = true;
    autoAskOnce(deps)
      .catch(() => {
        // 見回りの失敗で止めない(次の見回りで拾う)
      })
      .finally(() => {
        busy = false;
      });
  };
  // 起動直後はスレの読み込みが終わっていないので、少し置いてから1回目を打つ
  const first = setTimeout(tick, 3_000);
  const timer = setInterval(tick, intervalMs);
  return {
    running: () => busy,
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
