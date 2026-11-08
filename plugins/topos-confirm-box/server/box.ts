/**
 * Topos 側の確認箱を読む(読み取り専用)。ディスク上のデータ契約は
 * `packages/server/src/server/confirm-box/store.ts` と `antigravity/utils/notify_box.py`
 * が共有している。ここはその**読み手の写し**。
 *
 * 読むファイルは2つあり、役割が違う:
 *
 * 1. `events-YYYYMM.jsonl` … **箱の正本**。`{"t":"item"|"ack"|"ackall"|"push"|"chat"}` を
 *    追記で畳む。投函済みの項目と、既読/承認の状態を持つ。
 * 2. `pending_user_decisions.jsonl` … **中間形式**。投函側が書く `t` を持たない行で、
 *    `ingest-pending` が箱へ流し込む。**2026-10-21 時点で ingest は一度も走っていない**
 *    (同ディレクトリに `ingested_keys.json` が無い)ため、ここを見ないと
 *    「投函済みだがユーザーから見えない」項目が残る。だから両方を読んで、
 *    箱に入った項目(`key` が一致)は箱側だけを残して重複を落とす。
 *
 * 壊れた行・未知の `t` の行は無視する(契約)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfirmBoxItem, ConfirmBoxSourceStatus } from "../shared/contract.js";
import { compareConfirmBoxItems, KIND_LABEL, PRIORITIES } from "../shared/contract.js";
import {
  BACKGROUND_MAX,
  SUMMARY_MAX,
  SUBJECT_MAX,
  normalizeGroup,
  normalizeKey,
  normalizeOptions,
  normalizePriority,
  normalizeRecommended,
  normalizeStoppedCount,
  normalizeSubrank,
  normalizeThreadRef,
  parseJsonl,
  str,
} from "./normalize.js";

const EVENTS_FILE = /^events-\d{6}\.jsonl$/;
export const PENDING_FILE = "pending_user_decisions.jsonl";

// 一覧の再パースを避ける仕組みは、下の「events の差分読み」(readEvents)が担う。
// 2026-11-09 に、署名つきの全読み控え(eventsMemo)から、前回の位置から伸びたぶんだけ読む
// 差分読みへ置き換えた(数十MBの events-*.jsonl を毎回パースすると1回0.4〜1秒かかっていた)。

/** `TOPOS_CONFIRM_BOX_DIR` があればそれ、無ければ `~/.local/state/toposai/confirm_box`。
 *  store.ts の `resolveConfirmBoxDir()` と同じ規則(`~` 展開つき)。 */
export function resolveConfirmBoxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOPOS_CONFIRM_BOX_DIR;
  if (override && override.trim().length > 0) {
    return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  }
  return path.join(os.homedir(), ".local", "state", "toposai", "confirm_box");
}

// ---------------------------------------------------------------- 箱(events-*.jsonl)

/**
 * `events-*.jsonl` を**少しずつ**畳むための状態(2026-11-09)。
 * 追記専用なので、前回の位置から伸びたぶんだけを足せば同じ結果になる。
 * 当月のファイルが 41MB まで育ち、毎回の全読みが 0.4〜1秒かかっていた。
 */
export interface BoxEventFold {
  items: Map<string, ConfirmBoxItem>;
  // `key` だけで付いた判断印(中間形式の行へ付けたもの)。同じ key の item が**後から**
  // 箱へ流れてきても印が失われないよう、畳んだ後に1回だけ当てる。
  keyMarks: Set<string>;
  // `hide` イベントで隠された id(`unhide` で戻せる。追記順で後勝ち)。item 行は書き換えない。
  hidden: Set<string>;
}

export function newBoxEventFold(): BoxEventFold {
  return { items: new Map(), keyMarks: new Set(), hidden: new Set() };
}

/** 追記された行を畳み込む。**同じ行を二度入れると結果が変わる**(呼ぶ側が読んだ位置を持つ)。 */
export function foldBoxEventsInto(
  fold: BoxEventFold,
  records: readonly Record<string, unknown>[],
): void {
  const { items, keyMarks, hidden } = fold;
  for (const e of records) {
    switch (e.t) {
      case "item":
        applyItem(items, e);
        break;
      case "ack":
        applyAck(items, e);
        break;
      case "ackall":
        applyAckAll(items, e);
        break;
      case "hide":
        if (typeof e.id === "string" && e.id) hidden.add(e.id);
        break;
      case "unhide":
        if (typeof e.id === "string") hidden.delete(e.id);
        break;
      case "judgment":
        applyJudgment(items, e);
        if (e.judgment !== false) {
          const key = normalizeKey(e.key);
          if (key) keyMarks.add(key);
        }
        break;
      // "push" は表示に関係しない、"chat" は項目ではなく質問なので、この版では畳まない。
      // 未知の `t` も同じく無視する(契約)。
      default:
        break;
    }
  }
}

/** 畳んだ状態から表示用の Map を作る。**状態は壊さない**(次の差分読みで使い回す)。 */
export function finishBoxEventFold(fold: BoxEventFold): Map<string, ConfirmBoxItem> {
  const out = new Map<string, ConfirmBoxItem>();
  for (const [id, item] of fold.items) {
    if (fold.hidden.has(id)) continue;
    out.set(
      id,
      item.key && !item.judgment && fold.keyMarks.has(item.key)
        ? { ...item, judgment: true }
        : item,
    );
  }
  return out;
}

/** `events-*.jsonl` の行を1つの Map へ畳む(store.ts `ConfirmBoxStore` と同じ規則)。 */
export function foldBoxEvents(
  records: readonly Record<string, unknown>[],
): Map<string, ConfirmBoxItem> {
  const fold = newBoxEventFold();
  foldBoxEventsInto(fold, records);
  return finishBoxEventFold(fold);
}

function applyItem(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  // 同じ id の2件目以降は捨てる(store.ts と同じ。先着を正とする)
  if (typeof e.id !== "string" || !e.id || items.has(e.id)) return;
  if (typeof e.ts !== "number") return;
  const options = normalizeOptions(e.options);
  items.set(e.id, {
    id: e.id,
    kind: "box",
    priority: normalizePriority(e.priority),
    subrank: normalizeSubrank(e.subrank),
    group: normalizeGroup(e.group),
    subject: str(e.subject).slice(0, SUBJECT_MAX),
    summary: str(e.summary).slice(0, SUMMARY_MAX),
    background: str(e.background).slice(0, BACKGROUND_MAX),
    source: str(e.source, "unknown"),
    threadRef: normalizeThreadRef(e.thread_ref),
    threadId: str(e.thread_id).trim() || null,
    stoppedCount: normalizeStoppedCount(e.stopped_count),
    ...reporterField(e.reporter),
    ...imagesField(e.images, e.image_captions),
    options,
    recommended: normalizeRecommended(e.recommended, options),
    state: "new",
    urgency: e.urgency === "urgent" ? "urgent" : "normal",
    judgment: e.judgment === true,
    ...(typeof e.dup_count === "number" && e.dup_count > 1
      ? { dupCount: Math.floor(e.dup_count) }
      : {}),
    key: normalizeKey(e.key),
    agentId: null,
    workspaceId: null,
    ts: e.ts,
  });
}

function applyAck(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  const item = typeof e.id === "string" ? items.get(e.id) : undefined;
  if (!item) return;
  if (e.action === "approve") item.state = "approved";
  else if (item.state === "new") item.state = "read";
}

/** 後から付ける判断印(`{"t":"judgment","id":…}`)。**追記専用**で item 行は書き換えない。Vault判断カードには当てない(カードの順は frontmatter の `subrank:` が正本)。
 * バックフィルの対象には箱の item のほか、まだ箱へ流していない中間形式(`pending:<key>`)も
 * あるため、そちらの id も受け付ける(`mergeBoxAndPending` の命名に合わせる)。 */
function applyJudgment(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  if (typeof e.id !== "string") return;
  const item = items.get(e.id) ?? items.get(`pending:${e.id}`);
  if (item) item.judgment = true;
}

function applyAckAll(items: Map<string, ConfirmBoxItem>, e: Record<string, unknown>): void {
  const before = typeof e.before === "number" ? e.before : 0;
  for (const item of items.values()) {
    if (item.state === "new" && item.ts <= before) item.state = "read";
  }
}

// ---------------------------------------------------------------- 並べ替え(rerank)

export interface RerankOverride {
  priority?: ConfirmBoxItem["priority"];
  subrank?: number;
}

/**
 * `{"t":"rerank","id"|"key":…,"subrank":N,"priority":…}`(**箱イベント(events-*.jsonl)だけ**を読む。Python `load_items()` と同じ。保留ファイルの rerank は読まない)。
 * **追記専用**で item 行は書き換えない。Vault判断カードには当てない(カードの順は frontmatter の `subrank:` が正本)(hide / judgment と同じ流儀)。同じ対象への行は後勝ちで、
 * `priority` と `subrank` は片方だけでも効く。対象は項目の `id` か `key`(`pending:` は省略可)。
 */
export function parseReranks(
  records: readonly Record<string, unknown>[],
): Map<string, RerankOverride> {
  const out = new Map<string, RerankOverride>();
  mergeReranksInto(out, records);
  return out;
}

/** 追記された行の rerank を、既にある Map へ**足す**(後勝ち。差分読み用)。 */
export function mergeReranksInto(
  out: Map<string, RerankOverride>,
  records: readonly Record<string, unknown>[],
): void {
  for (const e of records) {
    if (e.t !== "rerank") continue;
    const target = typeof e.id === "string" && e.id ? e.id : normalizeKey(e.key);
    if (!target) continue;
    const next: RerankOverride = { ...out.get(target) };
    if (typeof e.subrank === "number" && Number.isInteger(e.subrank)) next.subrank = e.subrank;
    if (PRIORITIES.includes(e.priority as ConfirmBoxItem["priority"])) {
      next.priority = e.priority as ConfirmBoxItem["priority"];
    }
    if (next.subrank !== undefined || next.priority !== undefined) out.set(target, next);
  }
}

export function applyReranks(
  items: readonly ConfirmBoxItem[],
  reranks: ReadonlyMap<string, RerankOverride>,
): ConfirmBoxItem[] {
  if (reranks.size === 0) return [...items];
  return items.map((item) => {
    const o =
      reranks.get(item.id) ??
      (item.key ? (reranks.get(item.key) ?? reranks.get(`pending:${item.key}`)) : undefined);
    return o ? { ...item, ...o } : item;
  });
}

/** 箱のファイル一覧(古い順)。読めなければ空。 */
export function listEventFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => EVENTS_FILE.test(n))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 中間形式(pending_user_decisions.jsonl)

/**
 * `t` を持たない行 = 未決の判断項目。`t:"decision"` は決定済みなので `key` で突き合わせて外す。
 * `t:"chat"` と未知の `t` は、この版では表示しない。
 *
 * **`ts` を持たない**ので行番号を代理に使う(後ろの行ほど新しい)。
 * 並び順の最後の軸(ts降順)だけに効くので、値そのものは表示しない。
 */
/** 報告者表示名。文字列で空でなければ `{reporter}`、それ以外は何も足さない。 */
function reporterField(value: unknown): { reporter?: string } {
  const name = str(value).trim().slice(0, 80);
  return name ? { reporter: name } : {};
}

const MAX_ITEM_IMAGES = 4;
const MAX_ITEM_IMAGE_BYTES = 2 * 1024 * 1024;
const ITEM_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** 画像の1行キャプションの上限(画面の1行に収まる長さ)。 */
const CAPTION_MAX = 120;
// data URI にそのまま差し込むので、base64 以外の文字(空白・記号)や長さの狂ったものは受け付けない。
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 復号せずに数える。`=` の分を引かないと、ちょうど上限の画像が1バイト超えに見えて落ちる。 */
function decodedBase64Bytes(data: string): number {
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return (data.length / 4) * 3 - padding;
}

/** 画像の1行キャプション。文字列だけ拾い、画像の枚数に合わせて切る(足りない分は画面側で補う)。 */
function captionsField(value: unknown, count: number): Pick<ConfirmBoxItem, "imageCaptions"> {
  if (!Array.isArray(value) || count <= 0) return {};
  const captions = value
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().slice(0, CAPTION_MAX))
    .filter((c) => c.length > 0)
    .slice(0, count);
  return captions.length > 0 ? { imageCaptions: captions } : {};
}

/** Keeps at most 4 well-formed images; anything else is dropped rather than failing the item. */
function imagesField(
  value: unknown,
  captions?: unknown,
): Pick<ConfirmBoxItem, "images" | "imageCaptions"> {
  if (!Array.isArray(value)) return {};
  const images: Array<{ data: string; mimeType: (typeof ITEM_IMAGE_MIME_TYPES)[number] }> = [];
  for (const entry of value) {
    if (images.length >= MAX_ITEM_IMAGES) break;
    if (!entry || typeof entry !== "object") continue;
    const { data, mimeType } = entry as { data?: unknown; mimeType?: unknown };
    if (typeof data !== "string" || data.length === 0 || !BASE64_PATTERN.test(data)) continue;
    if (typeof mimeType !== "string") continue;
    if (!ITEM_IMAGE_MIME_TYPES.includes(mimeType as never)) continue;
    if (decodedBase64Bytes(data) > MAX_ITEM_IMAGE_BYTES) continue;
    images.push({ data, mimeType: mimeType as (typeof ITEM_IMAGE_MIME_TYPES)[number] });
  }
  return images.length > 0 ? { images, ...captionsField(captions, images.length) } : {};
}

export interface PendingParseResult {
  items: ConfirmBoxItem[];
  decidedKeys: Set<string>;
  /** key → 判断印。`t:"judgment"` の行(バックフィルの追記)を key で畳んだもの。
   * **箱に同じ key が無い行にだけ**効かせる(`mergeBoxAndPending` を参照)。 */
  overrides: Map<string, boolean>;
  problems: number;
}

export function parsePendingRecords(
  records: readonly Record<string, unknown>[],
): PendingParseResult {
  const items: ConfirmBoxItem[] = [];
  const decidedKeys = new Set<string>();
  const overrides = new Map<string, boolean>();
  let problems = 0;

  records.forEach((r, index) => {
    const t = r.t;
    if (typeof t === "string" && t.length > 0) {
      if (t === "decision") {
        const key = normalizeKey(r.key);
        if (key) decidedKeys.add(key);
      } else if (t === "judgment") {
        // 後から付ける判断印(追記専用)。ファイル順で後に来た行が勝つ(付与は最後に来る想定)
        const key = normalizeKey(r.key);
        if (key) overrides.set(key, r.judgment !== false);
      }
      return; // chat / 未知の t は無視
    }
    const key = normalizeKey(r.key);
    if (!key) {
      problems += 1; // key が無いと決定を書き戻せないので、この項目は出さない
      return;
    }
    const options = normalizeOptions(r.options);
    items.push({
      id: `pending:${key}`,
      kind: "pending",
      priority: normalizePriority(r.priority),
      subrank: normalizeSubrank(r.subrank),
      group: normalizeGroup(r.group),
      subject: str(r.subject).slice(0, SUBJECT_MAX),
      summary: str(r.summary).slice(0, SUMMARY_MAX),
      background: str(r.background).slice(0, BACKGROUND_MAX),
      source: str(r.source, "unknown"),
      threadRef: normalizeThreadRef(r.thread_ref),
      threadId: str(r.thread_id).trim() || null,
      stoppedCount: normalizeStoppedCount(r.stopped_count),
      ...reporterField(r.reporter),
      ...imagesField(r.images, r.image_captions),
      options,
      recommended: normalizeRecommended(r.recommended, options),
      state: "new",
      urgency: "normal",
      judgment: r.judgment === true,
      key,
      agentId: null,
      workspaceId: null,
      ts: typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : index,
    });
  });

  return { items, decidedKeys, overrides, problems };
}

// ---------------------------------------------------------------- 統合

/**
 * 箱と中間形式を1つにする。**同じ `key` が両方にあれば箱側だけ残す**
 * (箱側は既読/承認の状態を持つため。中間形式は ingest 前の控えにすぎない)。
 */
export function mergeBoxAndPending(
  boxItems: readonly ConfirmBoxItem[],
  pendingItems: readonly ConfirmBoxItem[],
  pendingOverrides: ReadonlyMap<string, boolean> = new Map(),
): ConfirmBoxItem[] {
  const boxKeys = new Set<string>();
  for (const item of boxItems) if (item.key) boxKeys.add(item.key);
  const merged = [...boxItems];
  for (const item of pendingItems) {
    if (item.key && boxKeys.has(item.key)) continue;
    // 箱側に同じ key が無い中間形式の行に付いた判断印(pending_overrides)。
    // 同一項目・同一トランザクションの行を1つに畳む(ファイル順で後に来た行が勝つ)。
    const mark = item.key ? pendingOverrides.get(item.key) : undefined;
    merged.push(mark === undefined ? item : { ...item, judgment: mark === true });
  }
  return merged.sort(compareConfirmBoxItems);
}

// ---------------------------------------------------------------- events の差分読み

/** 前回どこまで読んだか(ファイルごと)。 */
interface EventsTail {
  /** 次に読み始めるバイト位置(必ず行の先頭に合わせる)。 */
  offset: number;
  /** 最後に見たサイズ・mtime(書き換えの検出用)。 */
  size: number;
  mtimeMs: number;
}

const eventsCache = {
  value: null as null | {
    dir: string;
    files: Map<string, EventsTail>;
    fold: BoxEventFold;
    reranks: Map<string, RerankOverride>;
  },
};

/** テスト用: 差分読みの控えを捨てる(次の読みを全読みにする)。 */
export function resetEventsCache(): void {
  eventsCache.value = null;
}

function statOrNull(full: string): fs.Stats | null {
  try {
    return fs.statSync(full);
  } catch {
    return null;
  }
}

/**
 * `file` の `from` 以降を読み、**行の切れ目まで**だけ畳める形で返す。
 * 最後の行が書き込み途中(改行が無い)なら、その手前までにして次回へ回す。
 */
function readRecordsFrom(
  file: string,
  from: number,
): { records: Record<string, unknown>[]; next: number; size: number; mtimeMs: number } {
  const st = fs.statSync(file);
  if (st.size <= from) return { records: [], next: from, size: st.size, mtimeMs: st.mtimeMs };
  const len = st.size - from;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    const chunk = buf.subarray(0, read);
    const nl = chunk.lastIndexOf(0x0a); // 改行(0x0a)まで
    if (nl < 0) return { records: [], next: from, size: st.size, mtimeMs: st.mtimeMs };
    return {
      records: parseJsonl(chunk.subarray(0, nl + 1).toString("utf8")),
      next: from + nl + 1,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `events-*.jsonl` を読む。**前回から伸びたぶんだけ**を畳み込む(2026-11-09)。
 *
 * 当月のファイルが 41MB まで育ち、30秒ごとの一覧取得とボタンを押すたびの取り直しで
 * 毎回その全行を読んでいた(実測: 一覧1回あたり 0.4〜1.0 秒)。これが確認箱の
 * 「表示が遅い・押してもカードが消えるのが遅い」の主因。追記専用のファイルなので、
 * 前回読んだバイト位置から先だけ読めば同じ結果になる。
 *
 * ファイルが消えた/縮んだ/同じサイズで書き換えられた場合は、控えを捨てて全読みする(安全側)。
 */
/** 表示用の写し。控え(eventsCache)の中のオブジェクトをそのまま渡すと、呼び手の書き換えが次の読みへ漏れる。 */
function copyItems(items: Map<string, ConfirmBoxItem>): ConfirmBoxItem[] {
  const out: ConfirmBoxItem[] = [];
  for (const item of items.values()) out.push({ ...item });
  return out;
}

/** rerank の写し(同上)。 */
function copyReranks(reranks: Map<string, RerankOverride>): Map<string, RerankOverride> {
  const out = new Map<string, RerankOverride>();
  for (const [k, v] of reranks) out.set(k, { ...v });
  return out;
}

function readEvents(dir: string): {
  items: ConfirmBoxItem[];
  reranks: Map<string, RerankOverride>;
  ok: boolean;
  detail: string;
} {
  const files = listEventFiles(dir);
  if (files.length === 0) {
    return {
      items: [],
      reranks: new Map(),
      ok: true,
      detail: "events-*.jsonl なし(まだ投函されていない)",
    };
  }
  let cache = eventsCache.value && eventsCache.value.dir === dir ? eventsCache.value : null;
  if (cache) {
    const vanished = [...cache.files.keys()].some((n) => !files.includes(n));
    let rewritten = false;
    if (!vanished) {
      for (const name of files) {
        const prev = cache.files.get(name);
        if (!prev) continue; // 新しいファイルは 0 から読めばよい
        const st = statOrNull(path.join(dir, name));
        if (
          !st ||
          st.size < prev.offset ||
          (st.size === prev.size && st.mtimeMs !== prev.mtimeMs)
        ) {
          rewritten = true;
          break;
        }
      }
    }
    if (vanished || rewritten) cache = null;
  }
  const fullRead = cache === null;
  const next = cache ?? {
    dir,
    files: new Map<string, EventsTail>(),
    fold: newBoxEventFold(),
    reranks: new Map(),
  };
  try {
    for (const name of files) {
      const prev = next.files.get(name);
      const read = readRecordsFrom(path.join(dir, name), prev ? prev.offset : 0);
      if (read.records.length > 0) {
        foldBoxEventsInto(next.fold, read.records);
        mergeReranksInto(next.reranks, read.records);
      }
      next.files.set(name, { offset: read.next, size: read.size, mtimeMs: read.mtimeMs });
    }
    eventsCache.value = next;
    return {
      // 控えの中のオブジェクトをそのまま渡すと、呼び手が書き換えたときに次の読み(使い回しの道)へ
      // 漏れる(2026-11-09 マージで発覚)。表示用の写しを渡す。rerank も同様に写す。
      items: copyItems(finishBoxEventFold(next.fold)),
      reranks: copyReranks(next.reranks),
      ok: true,
      detail: `${files.join(", ")}${fullRead ? "" : "(追記ぶんだけ読み直し)"}`,
    };
  } catch (error) {
    // 途中で失敗したら控えを捨てる(半端な位置を残さず、次は全読みする)。
    eventsCache.value = null;
    return {
      items: [],
      reranks: new Map(),
      ok: false,
      detail: `読めません: ${(error as Error).message}`,
    };
  }
}

export interface ReadConfirmBoxResult {
  items: ConfirmBoxItem[];
  /** 並べ替えイベント(rerank)。Vault判断カード等、後から足す項目にも `applyReranks` で当てる。 */
  reranks: Map<string, RerankOverride>;
  sources: ConfirmBoxSourceStatus[];
  dir: string;
}

/** ディレクトリを読んで統合した一覧を返す。**例外を投げない**(読めない出所は status に出す)。 */
export function readConfirmBox(dir: string = resolveConfirmBoxDir()): ReadConfirmBoxResult {
  const sources: ConfirmBoxSourceStatus[] = [];
  const reranks = new Map<string, RerankOverride>();

  // --- 箱(前回から伸びたぶんだけ読む)
  const boxRead = readEvents(dir);
  const boxItems: ConfirmBoxItem[] = boxRead.items;
  const boxDetail = boxRead.detail;
  const boxOk = boxRead.ok;
  for (const [k, v] of boxRead.reranks) reranks.set(k, { ...reranks.get(k), ...v });

  // --- 中間形式
  let pendingItems: ConfirmBoxItem[] = [];
  let pendingOverrides = new Map<string, boolean>();
  let pendingDetail = "";
  let pendingOk = true;
  // 決定済み key(中間形式の決定行 + 箱側の項目を外すのに使う)。
  let decidedKeys = new Set<string>();
  const pendingPath = path.join(dir, PENDING_FILE);
  if (!fs.existsSync(pendingPath)) {
    pendingDetail = `${PENDING_FILE} なし`;
  } else {
    try {
      // 同じファイルを2回読まない(以前は decidedKeys のために全読みしていた。2026-11-09)。
      const parsed = parsePendingRecords(parseJsonl(fs.readFileSync(pendingPath, "utf8")));
      pendingOverrides = parsed.overrides;
      decidedKeys = parsed.decidedKeys;
      // 決定済みの key を外す(投函側が箱へ流す前でも、決めたものが残らないように)
      pendingItems = parsed.items.filter((i) => !(i.key && parsed.decidedKeys.has(i.key)));
      pendingDetail =
        `${PENDING_FILE}(決定済み ${parsed.decidedKeys.size} 件を除外` +
        (parsed.problems > 0 ? `・key 無し ${parsed.problems} 件を除外` : "") +
        ")";
    } catch (error) {
      pendingOk = false;
      pendingDetail = `読めません: ${(error as Error).message}`;
    }
  }
  // 増分読みは item の実体を次の一覧にも使い回す。ここで直接書き換えると、決定行が消えても
  // approved のまま残る(2026-11-09 レビュー指摘)。差し替えで対応する。
  for (let i = 0; i < boxItems.length; i += 1) {
    const item = boxItems[i];
    if (item.key && decidedKeys.has(item.key)) boxItems[i] = { ...item, state: "approved" };
  }

  sources.push({
    id: "box",
    label: KIND_LABEL.box,
    ok: boxOk,
    detail: boxDetail,
    count: boxItems.length,
  });
  sources.push({
    id: "pending",
    label: KIND_LABEL.pending,
    ok: pendingOk,
    detail: pendingDetail,
    count: pendingItems.length,
  });

  return {
    items: applyReranks(mergeBoxAndPending(boxItems, pendingItems, pendingOverrides), reranks).sort(
      compareConfirmBoxItems,
    ),
    reranks,
    sources,
    dir,
  };
}

// ---------------------------------------------------------------- 決定の書き戻し

/**
 * `{"t":"decision",...}` を `pending_user_decisions.jsonl` へ追記する。
 * 契約は `handoff_confirm_box_recommendation_feedback_kickoff.md` で固定。
 * `matched` は**投函側(ここ)が機械計算**する(読み手ごとに解釈が揺れないように)。
 *
 * 追記は O_APPEND の単一 write(箱と同じ流儀。書き手が複数プロセスでも行が混ざらない)。
 */
export function appendDecision(
  dir: string,
  decision: {
    key: string;
    chosen: string | null;
    recommended: string | null;
    depth: string;
    reason: string;
    source: string;
  },
  now: number = Date.now(),
): void {
  const record = {
    t: "decision",
    key: decision.key,
    ts: now,
    chosen: decision.chosen,
    recommended: decision.recommended,
    matched:
      decision.chosen !== null &&
      decision.recommended !== null &&
      decision.chosen === decision.recommended,
    depth: decision.depth,
    decided_by: "user",
    reason: decision.reason,
    source: decision.source,
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dir, PENDING_FILE), "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
