/**
 * 判断項目の出所を Vault の判断ノート(`05_Projects/ToposAI/ユーザー判断/j-*.md`)に一本化する。
 *
 * 正本は Vault の判断ノート(2026-10-22 ユーザー決定)。確認箱の画面は以前、箱の
 * `events-*.jsonl` と `pending_user_decisions.jsonl` だけを読んでいたため、Vault で
 * answered/superseded にしても画面から消えなかった(2026-10-24 調査)。
 *
 * - 読み: `state: open | waiting_materials` のノートだけを判断項目にする(answered/superseded/
 *   deferred は出さない)。
 * - 書き: 画面で答えたら、同じノートの frontmatter と「回答原文」を更新する。**書き先は
 *   Obsidian 本体のみ**。バックアップ(`Obsidian-Git`)配下は読みも書きも拒否する。
 * - 箱側の既存 judgment 行(旧項目)は画面に出さない。消さず、読み込み時に隠すだけ(復元可能)。
 */
import fs from "node:fs";
import path from "node:path";
import type { ConfirmBoxItem, ConfirmBoxOption } from "../shared/contract.js";
import { isLegacyOptionItem } from "../shared/contract.js";
import { isBackupPath, resolveVaultDir } from "./notes.js";
import { BACKGROUND_MAX, SUMMARY_MAX, SUBJECT_MAX, normalizePriority } from "./normalize.js";

export const VAULT_DECISION_SOURCE = "vault_decision_note";
export const VAULT_KEY_PREFIX = "vault:";
const DECISION_SUBDIR = path.join("05_Projects", "ToposAI", "ユーザー判断");
const NOTE_FILE = /^j-[0-9A-Za-z][0-9A-Za-z-]*\.md$/;
const NOTE_ID = /^j-[0-9A-Za-z][0-9A-Za-z-]*$/;
const MAX_NOTES = 1000;
const MAX_BYTES = 256 * 1024;
const SHOWN_STATES = new Set(["open", "waiting_materials"]);

/** 判断ノートのディレクトリ。バックアップ配下なら throw(読みも書きもしない)。 */
export function resolveDecisionDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR?.trim();
  const dir = override ? override : path.join(resolveVaultDir(env), DECISION_SUBDIR);
  if (isBackupPath(dir)) {
    throw new Error(`バックアップは読みません(書込禁止の一方向同期先): ${dir}`);
  }
  return dir;
}

/** 画面側の判断項目の出所を Vault に一本化するか。`TOPOS_CONFIRM_BOX_VAULT_SOURCE=0` で旧挙動。 */
export function vaultSourceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TOPOS_CONFIRM_BOX_VAULT_SOURCE !== "0";
}

// ---------------------------------------------------------------- パース

interface Parsed {
  front: Record<string, string>;
  body: string;
}

function splitFrontmatter(text: string): Parsed | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(
    text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"),
  );
  if (!m) return null;
  const front: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { front, body: m[2] };
}

function section(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m");
  const m = re.exec(body);
  return m ? m[1].trim() : "";
}

/** 「a 〜 / b 〜(推奨)」を選択肢へ。2つ未満しか取れなければ空(チャットでだけ答える項目)。 */
export function parseOptions(text: string): {
  options: ConfirmBoxOption[];
  recommended: string | null;
} {
  const options: ConfirmBoxOption[] = [];
  let recommended: string | null = null;
  const firstLine = text.split("\n")[0] ?? "";
  for (const part of firstLine.split(/\s\/\s/)) {
    const m = /^([a-f])\s+(.+)$/.exec(part.trim());
    if (!m) continue;
    const raw = m[2].trim();
    if (/推奨/.test(raw)) recommended = m[1];
    const label = raw
      .replace(/[(（]推奨[^)）]*[)）]/g, "")
      .replace(/[=＝]\s*推奨/g, "")
      .trim();
    options.push({ id: m[1], label: label || raw });
  }
  if (options.length < 2) return { options: [], recommended: null };
  return { options, recommended };
}

export function parseDecisionNote(text: string, mtimeMs: number): ConfirmBoxItem | null {
  const parsed = splitFrontmatter(text);
  if (!parsed) return null;
  const { front, body } = parsed;
  const id = front.id;
  if (!id || !NOTE_ID.test(id)) return null;
  if (!SHOWN_STATES.has((front.state ?? "").toLowerCase())) return null;
  const title = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? id;
  const background = section(body, "背景");
  const { options, recommended } = parseOptions(section(body, "選択肢と推奨"));
  const waiting = front.state.toLowerCase() === "waiting_materials";
  const materials = front.materials && front.materials !== "null" ? front.materials : "";
  const summaryBase = background.split("\n").find((l) => l.trim()) ?? "";
  const summary = waiting
    ? `【材料待ち】${materials || "材料が揃うのを待っています"}`
    : summaryBase;
  const key = `${VAULT_KEY_PREFIX}${id}`;
  return {
    id: `pending:${key}`,
    kind: "pending",
    priority: normalizePriority(front.priority),
    subrank: 0,
    group: null,
    subject: title.slice(0, SUBJECT_MAX),
    summary: summary.slice(0, SUMMARY_MAX),
    background: background.slice(0, BACKGROUND_MAX),
    source: VAULT_DECISION_SOURCE,
    threadRef: null,
    stoppedCount: 0,
    options,
    recommended,
    state: "new",
    urgency: "normal",
    judgment: true,
    key,
    agentId: null,
    workspaceId: null,
    ts: Math.floor(mtimeMs),
  };
}

export interface VaultDecisionRead {
  items: ConfirmBoxItem[];
  /** 画面に出す理由のある失敗(ディレクトリが読めない等)。無ければ null。 */
  error: string | null;
  dir: string;
  /** 読めずに出せなかったノート(件数だけ画面の状態表示に出す。無言で欠落させない)。 */
  skipped: { name: string; reason: string }[];
  /**
   * `waiting_materials`(AI側が材料を集めている最中)のノート数。ユーザーが答える項目ではないので
   * 判断タブには出さず、件数だけ状態表示に出す(2026-10-24: 画面18件のうち材料待ち3件はユーザー判断でなかった)。
   */
  waiting: number;
  /**
   * どの状態のノートでも、frontmatter の `legacy_keys` に入っている箱側の key。箱へ投函された判断は
   * Vault ノート化(deposit→ノート)されると、箱側の行を画面に出さない(併存をやめて一本化)。
   */
  claimedKeys: string[];
}

/**
 * frontmatter の `legacy_keys` を key の配列へ。`[a, b]`(インライン)と YAML リスト
 * (`legacy_keys:` の次行以降に `- a`。Vault 側の整形処理がこの形に書き換えることがある)の両方を読む。
 */
export function parseLegacyKeys(text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  if (!m) return [];
  const unq = (k: string) => k.trim().replace(/^(["'])(.*)\1$/, "$2");
  const lines = m[1].split("\n");
  const at = lines.findIndex((l) => l.startsWith("legacy_keys:"));
  if (at < 0) return [];
  const rest = lines[at].replace(/^legacy_keys:\s*/, "").trim();
  const inline = /^\[(.*)\]$/.exec(rest);
  if (inline) return inline[1].split(",").map(unq).filter(Boolean);
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const li = /^\s*-\s+(.+)$/.exec(lines[i]);
    if (!li) break;
    out.push(unq(li[1]));
  }
  return out.filter(Boolean);
}

/** 状態を問わず legacy_keys を集める(answered/superseded でも箱側の行は復活させない)。
 * ただし state が読めない壊れたノートは claim しない(箱の行だけ隠れて判断が消えるのを防ぐ)。 */
function claimableKeys(text: string): string[] {
  return splitFrontmatter(text)?.front.state ? parseLegacyKeys(text) : [];
}

/** 判断ノートを読む。**例外を投げない**(読めない時は error に理由を入れる)。 */
export function readVaultDecisions(env: NodeJS.ProcessEnv = process.env): VaultDecisionRead {
  let dir = "";
  try {
    dir = resolveDecisionDir(env);
    const names = fs
      .readdirSync(dir)
      .filter((n) => NOTE_FILE.test(n))
      .sort()
      .toReversed() // 上限を超えたら古い(日付の小さい)ノートから落とす
      .slice(0, MAX_NOTES);
    const items: ConfirmBoxItem[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const seen = new Set<string>();
    const claimed = new Set<string>();
    let waiting = 0;
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > MAX_BYTES) {
          skipped.push({ name, reason: "ファイルでない/大きすぎる" });
          continue;
        }
        const text = fs.readFileSync(full, "utf8");
        for (const k of claimableKeys(text)) claimed.add(k);
        const item = parseDecisionNote(text, st.mtimeMs);
        if (!item) continue; // open/waiting_materials 以外・frontmatter なしは対象外(欠落ではない)
        // ファイル名と id が違うノートは、回答の書き先が別ノートになるので出さない
        if (
          `${(item.key ?? "").slice(VAULT_KEY_PREFIX.length)}.md` !== name ||
          seen.has(item.key ?? "")
        ) {
          skipped.push({ name, reason: "id がファイル名と違う/重複" });
          continue;
        }
        seen.add(item.key ?? "");
        if (/^waiting_materials$/i.test(splitFrontmatter(text)?.front.state ?? "")) {
          waiting += 1;
          continue;
        }
        items.push(item);
      } catch {
        skipped.push({ name, reason: "読めない" });
      }
    }
    return { items, error: null, dir, skipped, waiting, claimedKeys: [...claimed] };
  } catch (error) {
    return {
      items: [],
      error: (error as Error).message,
      dir,
      skipped: [],
      waiting: 0,
      claimedKeys: [],
    };
  }
}

// ---------------------------------------------------------------- 箱側の旧judgment行を隠す

/**
 * 切替時刻(2026-10-24 18:00 JST)。これより前に箱へ入った judgment 行だけを旧項目として隠す。
 * 以降に投函された判断(confirm_box_deposit が今も箱へ書く)は Vault にノートが無くても見せる
 * (全隠しにすると新規の判断が誰にも見えなくなる: 出口レビュー round1 指摘4)。
 */
export const LEGACY_CUTOVER_MS = 1792832436000;

/** 画面に出さない箱側の判断行か。Vault 出所の項目・permit(Paseo の承認待ち)・切替後の投函は対象外。 */
export function isHiddenLegacyJudgment(item: ConfirmBoxItem): boolean {
  if (item.kind === "permit" || item.source === VAULT_DECISION_SOURCE) return false;
  if (item.ts >= LEGACY_CUTOVER_MS) return false;
  return item.judgment === true || isLegacyOptionItem(item);
}

/** Vault を読めなかった(`vaultFailed`)ときは旧行を隠さない(空表示にしない)。 */
export function applyVaultSource(
  boxItems: readonly ConfirmBoxItem[],
  vaultItems: readonly ConfirmBoxItem[],
  vaultFailed = false,
  claimedKeys: readonly string[] = [],
): { items: ConfirmBoxItem[]; hidden: ConfirmBoxItem[] } {
  const hidden: ConfirmBoxItem[] = [];
  const kept: ConfirmBoxItem[] = [];
  const claimed = new Set(claimedKeys);
  for (const item of boxItems) {
    // Vault にノートがある(legacy_keys)判断は箱側の行を出さない。permit は対象外
    const claimedByNote =
      item.kind !== "permit" && item.judgment === true && !!item.key && claimed.has(item.key);
    if (!vaultFailed && (claimedByNote || isHiddenLegacyJudgment(item))) hidden.push(item);
    else kept.push(item);
  }
  return { items: [...kept, ...vaultItems], hidden };
}

// ---------------------------------------------------------------- 回答の書き戻し

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(now: Date): { date: string; iso: string } {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return {
    date,
    iso: `${date}:${pad2(now.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`,
  };
}

function rewriteFrontmatter(fm: string[], date: string, iso: string): string[] {
  const out = [...fm];
  const setKey = (k: string, v: string) => {
    const i = out.findIndex((l) => l.startsWith(`${k}:`));
    if (i >= 0) out[i] = `${k}: ${v}`;
    else out.push(`${k}: ${v}`);
  };
  setKey("state", "answered");
  setKey("answered_at", iso);
  setKey("route", "chat");
  const entry = `- ${date} (user: 確認箱で回答)`;
  const hi = out.findIndex((l) => l.startsWith("modified_history:"));
  if (hi < 0) return [...out, "modified_history:", entry];
  if (/^modified_history:\s*\[\s*\]\s*$/.test(out[hi])) out[hi] = "modified_history:";
  let at = hi + 1;
  while (at < out.length && /^\s*- /.test(out[at])) at += 1;
  out.splice(at, 0, entry);
  return out;
}

function answerLine(answer: VaultAnswer, date: string): string {
  const label = answer.chosenLabel ? `「${answer.chosenLabel}」` : "";
  const one = (t: string) => t.replace(/[\r\n]+/g, " ").trim();
  const chosen = answer.chosenId ? `選択 ${one(answer.chosenId)}${one(label)}` : "選択なし";
  const reason = answer.reason.trim() ? `(理由: ${one(answer.reason)})` : "";
  return `- 「${date} (確認箱): ${chosen}${reason}」`;
}

function rewriteAnswerSection(rest: string[], line: string): string[] {
  const out = [...rest];
  const hIdx = out.findIndex((l) => /^##\s+回答原文/.test(l));
  if (hIdx < 0) return [...out, "", "## 回答原文と日時", line, ""];
  let j = hIdx + 1;
  while (j < out.length && !/^##\s/.test(out[j])) j += 1;
  const block = out.slice(hIdx + 1, j).filter((l) => l.trim() && !/^-\s*\(未回答\)/.test(l));
  out.splice(hIdx + 1, j - hIdx - 1, ...block, line, "");
  return out;
}

export interface VaultAnswer {
  /** `vault:<id>`。 */
  key: string;
  chosenId: string | null;
  chosenLabel: string | null;
  reason: string;
}

/**
 * 判断ノートを answered にする。書き先は判断ノートのディレクトリ内の `<id>.md` だけ。
 * すでに open/waiting_materials でなければ書かずに throw(別経路で答え済みのものを上書きしない)。
 */
export function answerVaultDecision(
  answer: VaultAnswer,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!answer.key.startsWith(VAULT_KEY_PREFIX)) throw new Error("Vault の判断ノートではありません");
  const id = answer.key.slice(VAULT_KEY_PREFIX.length);
  if (!NOTE_ID.test(id)) throw new Error(`判断ノートの id が不正です: ${id}`);
  const dir = resolveDecisionDir(env);
  const file = path.join(dir, `${id}.md`);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir) || isBackupPath(file)) {
    throw new Error("書き込み先が判断ノートのディレクトリの外です");
  }
  // シンボリックリンク経由でバックアップへ書かない(実体パスでも判定。ノート自体のリンクも拒否)
  if (isBackupPath(fs.realpathSync(dir)) || fs.lstatSync(file).isSymbolicLink()) {
    throw new Error("書き込み先がバックアップまたはシンボリックリンクです");
  }
  const text = fs.readFileSync(file, "utf8");
  const parsed = splitFrontmatter(text);
  if (!parsed || parsed.front.id !== id) throw new Error("判断ノートの frontmatter を読めません");
  if (!SHOWN_STATES.has(parsed.front.state.toLowerCase())) {
    throw new Error(`すでに ${parsed.front.state} です(上書きしません)`);
  }
  const { date, iso } = stamp(now);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error("frontmatter の終端がありません");
  const fm = rewriteFrontmatter(lines.slice(1, end), date, iso);
  const rest = rewriteAnswerSection(lines.slice(end + 1), answerLine(answer, date));
  const out = ["---", ...fm, "---", ...rest].join("\n");
  // 同じディレクトリへ一時ファイル→rename(途中で切れても半端なノートを残さない)
  const tmp = path.join(dir, `.${id}.md.tmp-${process.pid}`);
  fs.writeFileSync(tmp, out, { mode: 0o644 });
  try {
    const cur = fs.readFileSync(file, "utf8");
    if (cur !== text) throw new Error("書き込み中にノートが変更されました。もう一度試してください");
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return file;
}

// ---------------------------------------------------------------- 通知の束ね

/**
 * 同一 source・同一内容(subject+summary)の**未読**通知を1行に束ねる(代表=最新)。
 * 既読は束ねない(画面に出さない)。判断・permit・完了まとめなど通知でない項目は触らない。
 */
export function bundleNotifications(
  items: readonly ConfirmBoxItem[],
  isNotification: (item: ConfirmBoxItem) => boolean,
): ConfirmBoxItem[] {
  const groups = new Map<string, ConfirmBoxItem[]>();
  for (const item of items) {
    if (!isNotification(item) || item.state !== "new") continue;
    const k = `${item.source}\u0000${item.subject}\u0000${item.summary}`;
    const g = groups.get(k);
    if (g) g.push(item);
    else groups.set(k, [item]);
  }
  const drop = new Set<string>();
  const rep = new Map<string, ConfirmBoxItem>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => b.ts - a.ts);
    rep.set(sorted[0].id, {
      ...sorted[0],
      dupCount: g.length,
      memberIds: g.map((i) => i.id),
    });
    for (const i of sorted.slice(1)) drop.add(i.id);
  }
  return items.filter((i) => !drop.has(i.id)).map((i) => rep.get(i.id) ?? i);
}
