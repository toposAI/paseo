/**
 * 窓口Bの右側の「ぼくの指示がいまどうなっているか」の**表示の決まり**(純粋な関数だけ)。
 *
 * どの指示がどの状態かは Python(`antigravity/utils/window_b_instruction_panel.py`)が決める。
 * ここが持つのは表示の規則だけ: 取れなかったときの扱い・並び・開く場所。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import {
  WINDOW_B_KIND,
  type WindowBInstruction,
  type WindowBInstructionsOutput,
} from "./contract.js";

/** 窓口(旧窓口B。2026-11-05 の入れ替えで B.id が変わった)のスレID。ここを見て「窓口Bの画面か」を決め、窓口Bの画面でだけ指示一覧を自動で出す。 */
export const WINDOW_B_AGENT_ID = "c153ffd0-7509-4e21-adb2-86ef22f10c82";

/** PC幅の下限(ホストの compact 境界と同じ720px)。 */
export const WIDE_MIN_WIDTH = 720;

/**
 * 画面に出す一覧を決める。
 * - 新しい取得が成功した → それを使う(error は消す)
 * - 失敗した → **前回取れた一覧を残し**、error だけ出す(取れない瞬間に「0件」へ戻すと、
 *   指示が消えたように見える)。まだ一度も取れていなければ null(= 空ではなく「取れない」)。
 */
export function keepLastOnFailure(
  previous: WindowBInstructionsOutput | null,
  next: { ok: true; data: WindowBInstructionsOutput } | { ok: false; error: string },
): { data: WindowBInstructionsOutput | null; error: string | null } {
  if (next.ok) return { data: next.data, error: null };
  return { data: previous, error: next.error };
}

/** 見出しに出す短い要約。「N件」だけだと赤の有無を読むのに一覧を目で数えることになる。 */
export function summarize(data: WindowBInstructionsOutput | null): string {
  if (!data) return "読み込めていません";
  const parts = [`${data.total}件`];
  if (data.alerts > 0) parts.push(`赤 ${data.alerts}`);
  if (data.warns > 0) parts.push(`未登録 ${data.warns}`);
  return parts.join(" / ");
}

/**
 * PC幅のパネルの見出しに出す追加の件数。PC幅は会話の上の帯(`bandText`)が「指示 N件・赤N」を
 * 出しているので、同じ件数をパネルの見出しでも繰り返さない(2026-11-07 指摘「同じ146件が3か所」)。
 * 帯に無い「未登録」だけを返し、無ければ null。
 */
export function summarizeExtras(data: WindowBInstructionsOutput | null): string | null {
  if (!data || data.warns <= 0) return null;
  return `未登録 ${data.warns}`;
}

/**
 * 見出しに出す件数。PC幅は帯と重ならないよう「未登録」だけ、狭い幅は件数と赤を出す。
 * 狭い幅で一覧を上限で切っているときは、下の「全N件中 上位M件を表示」が件数を出すので、
 * 見出しでは件数を繰り返さない(2026-11-07 指摘「iPhone幅で154件が2回」)。
 */
export function headCountText(
  data: WindowBInstructionsOutput | null,
  wide: boolean,
): string | null {
  if (!data) return summarize(null);
  if (wide) return summarizeExtras(data);
  const parts: string[] = [];
  if (truncationNote(data) === null) parts.push(`${data.total}件`);
  if (data.alerts > 0) parts.push(`赤 ${data.alerts}`);
  if (data.warns > 0) parts.push(`未登録 ${data.warns}`);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** 見せ方に合わせた一覧の行(取得前は空)。 */
export function visibleRows(
  data: WindowBInstructionsOutput | null,
  mode: ListMode,
): WindowBInstruction[] {
  return data ? filterByMode(rowOrder(data.items), mode) : [];
}

/** 一覧の並び。赤 → 判断待ち → 未登録 → その他 → 完了。同じ群の中は Python の並びのまま(安定ソート)。 */
export function rowOrder<
  T extends { alert: string | null; warn: string | null; kind: string; stalled?: boolean },
>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** 並びの群(小さいほど上)。 */
function rank(row: {
  alert: string | null;
  warn: string | null;
  kind: string;
  stalled?: boolean;
}): number {
  if (row.alert) return 0;
  if (row.kind === WINDOW_B_KIND.judgment) return 1;
  // 止まっている(長く動きがない進行中)は、普通の作業中より上。完了は止まりに数えない。
  if (row.stalled && row.kind !== WINDOW_B_KIND.done) return 2;
  // 「届いたか」そのものが知りたいことなので、届いたか不明・返事なしは状態の順で後ろへ回さない。
  if (row.kind === WINDOW_B_KIND.unknown || row.kind === WINDOW_B_KIND.noReply) return 2;
  if (row.warn) return 3;
  if (row.kind === WINDOW_B_KIND.done) return 5;
  return 4;
}

/**
 * 一覧のうち何件を出しているか。上限で切ったと分からないと「出ている範囲で赤が無い」と読み違える。
 * 注意書き全体を最大2行に収めるため、長い説明は添えず1行に収まる長さにする(並び順の説明は
 * 見出しの要約「赤 N / 未登録 M」と、赤が先頭に来ること自体で足りる)。
 */
export function truncationNote(data: WindowBInstructionsOutput, omitTotal = false): string | null {
  if (data.total <= data.items.length) return null;
  // PC幅は会話の上の帯が「指示 N件」を出しているので、件数を繰り返さない(2026-11-07 指摘
  // 「PCの指示一覧で157件が2か所」)。狭い幅は帯が件数を出さないため、ここで全件数を出す。
  return omitTotal
    ? `上位${data.items.length}件を表示`
    : `全${data.total}件中 上位${data.items.length}件を表示`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 一覧を開く場所。PC幅は右カラム、iPhone幅は主ペイン(全画面。戻るで閉じる)。
 */
export function paneLocation(width: number): "right" | "workspace" {
  return width >= WIDE_MIN_WIDTH ? "right" : "workspace";
}

/** これより古い読み出しは「古い表示」として目立たせる(2026-10-30 依頼「15分より古いとき」)。 */
export const STALE_AFTER_MS = 15 * 60_000;

/**
 * 「古い表示(HH:MM時点)」の一行。読み出した時刻が `now` より15分以上前なら出す(それ以外は null)。
 * 30秒ごとに引き直すので、普通はここに来ない。来るのは引き直しが止まったとき=古い「作業中」が
 * そのまま正常に見えてしまうときで、黙って出し続けない。
 */
export function staleNotice(data: WindowBInstructionsOutput, now: number): string | null {
  if (now - data.generatedAt < STALE_AFTER_MS) return null;
  return `古い表示(${clock(data.generatedAt)}時点)`;
}

/** 一覧の見せ方。active=完了を隠す(既定) / done=完了だけ(直近3日。Python が返す範囲)。 */
export type ListMode = "active" | "done";

/**
 * 見せ方に合わせて行を絞る。完了の判定は Python の状態の語(WINDOW_B_KIND.done)と一致させる。
 * 「完了だけ」の間も、判断待ち・赤・橙の行は隠さない(置きっぱなしで新しい判断待ちが見えなくなるのを防ぐ。
 * 2026-10-30 出口レビュー指摘7a)。「完了報告待ち」は完了ではないので、どちらの見せ方でも隠さない。
 */
export function filterByMode<
  T extends { kind: string; alert?: string | null; warn?: string | null },
>(rows: readonly T[], mode: ListMode): T[] {
  return rows.filter((r) => {
    const isDone = r.kind === WINDOW_B_KIND.done;
    if (mode === "active") return !isDone;
    return (
      isDone ||
      Boolean(r.alert) ||
      Boolean(r.warn) ||
      r.kind === WINDOW_B_KIND.judgment ||
      r.kind === WINDOW_B_KIND.reportPending
    );
  });
}

/** 「完了だけ」ボタンの文字(件数つき)。 */
export function doneButtonText(mode: ListMode, doneCount: number): string {
  return mode === "done" ? "一覧にもどる" : `完了だけ(${doneCount})`;
}

/** 絞った結果が空のときの文。 */
export function emptyText(mode: ListMode): string {
  return mode === "done" ? "直近3日の完了はありません" : "進行中の指示はありません";
}

export type InstructionRoute = NonNullable<WindowBInstruction["routes"]>[number];

/** カードを閉じているときに出す項目の数。残りは「ほかN項目」にまとめる(押すと全部開く)。 */
export const ROUTES_COLLAPSED = 3;

/**
 * 項目1行の「振り先と進み具合」。例: `1. 画像を出す ・ 子スレ「実装スレ」 ・ 実装中`。
 * 進み具合は、完了なら「完了」、子スレなら子スレの自己申告の状態(登録簿に居なければ「状態不明」)、
 * それ以外は依頼台帳の状態。種別が空なら「まだ振っていない」(振り先が付くまで空のまま)。
 */
export function routeText(r: InstructionRoute): string {
  const dest = r.dest === "" ? "まだ振っていない" : r.dest;
  const wrapped = r.dest === "子スレ" ? `「${r.assignee}」` : `(${r.assignee})`;
  const who = r.assignee ? wrapped : "";
  let progress = r.status;
  if (r.done) progress = "完了";
  else if (r.dest === "子スレ") progress = r.childStatus ?? "状態不明";
  return [`${r.no}. ${r.summary}`.trimEnd(), `${dest}${who}`, progress]
    .filter(Boolean)
    .join(" ・ ");
}

/** 項目行の出し分け。画面は開いたときだけ呼ぶ(閉じたカードは日付とタイトルだけ)。閉じ側の分岐は互換のため残す。 */
export function visibleRoutes(
  routes: readonly InstructionRoute[] | undefined,
  open: boolean,
): { shown: InstructionRoute[]; hidden: number } {
  const all = routes ?? [];
  if (open || all.length <= ROUTES_COLLAPSED) return { shown: [...all], hidden: 0 };
  return { shown: all.slice(0, ROUTES_COLLAPSED), hidden: all.length - ROUTES_COLLAPSED };
}

/** 「N分前 / N時間前 / N日前」。未来や不正な値は空。 */
export function agoText(lastAtSec: number | undefined, nowMs: number): string {
  if (lastAtSec === undefined) return "";
  const diff = Math.floor((nowMs - lastAtSec * 1000) / 60_000);
  if (diff < 0) return "";
  if (diff < 60) return `${Math.max(diff, 1)}分前`;
  if (diff < 60 * 24) return `${Math.floor(diff / 60)}時間前`;
  return `${Math.floor(diff / (60 * 24))}日前`;
}

/** カードの段階名。古いサーバ(stage 無し)は状態の語のまま。 */
export function stageText(item: { stage?: string; kind: string }): string {
  return item.stage ?? item.kind;
}

/** 担当と最後に動いた時刻の1行(閉じたカードにも出す)。例: `担当: 家族版出荷13 ・ 最後の動き 11/07 16:32(16時間前)`。 */
export function ownerLine(
  item: { assigneeText: string; lastText?: string; lastAt?: number },
  nowMs: number,
): string {
  const who = `担当: ${plainAssignee(item.assigneeText.replace(/^\(担当未定\)$/, ""))}`;
  if (!item.lastText) return who;
  const ago = agoText(item.lastAt, nowMs);
  return `${who} ・ 最後の動き ${item.lastText}${ago ? `(${ago})` : ""}`;
}

/** 隠した自動送信の短い一言。0件なら null。 */
export function hiddenAutoText(data: WindowBInstructionsOutput | null): string | null {
  const n = data?.hiddenAuto?.count ?? 0;
  return n > 0 ? `自動送信・スレ間の連絡${n}件は非表示` : null;
}

/** 閉じたカードのタイトル。要約(title)が空なら全文の1行目。逐語でない要約は作らない。 */
export function rowTitle(item: { title: string; text: string }): string {
  if (item.title.trim() !== "") return plainTitle(item.title);
  const firstLine =
    item.text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return plainTitle(firstLine);
}

/** 語の区切りを出すための分割器(無い環境では何もしない)。 */
interface WordSegmenter {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}

const WORD_SEGMENTER: WordSegmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (
        Intl as unknown as {
          Segmenter: new (locale: string, opts: { granularity: string }) => WordSegmenter;
        }
      ).Segmenter("ja", { granularity: "word" })
    : null;

/** 語中の字を繋ぐ見えない字(WORD JOINER)。ここでは折れなくなる。 */
const WORD_JOINER = "\u2060";

/** 語として繋ぐ対象(かな・漢字)。英数字の語は繋がない(URL などが折れなくなるのを避ける)。 */
const CJK_WORD = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/** ひらがなだけの語(助詞・助動詞・接尾辞)。前の語に付けて1語として扱う。 */
const HIRAGANA_ONLY = /^[぀-ゟ]+$/;

/** 行末に置いてよいが、行頭に来ると読みにくい閉じ括弧。前の語に付ける。 */
const CLOSER = /^[）)」』】〉》]+$/;

/** 行頭に来てもよいが、行末に置くと宙に浮く開き括弧。直後の語を付ける。 */
const OPENER = /^[（(「『【〈《]+$/;

/** 折り目を作ってよい最短の長さ(字)。これ未満で折ると文節が細切れに見える。 */
const MIN_BREAK_CHARS = 5;

/** 繋いだ語の上限(字)。これを超えると折り目が無くなって、はみ出す危険が出る。 */
const MAX_JOINED_CHARS = 24;

/** 1つの語(または区切り)の素性。折り目を付けてよいかを判断する材料。 */
interface Piece {
  text: string;
  cjk: boolean;
  /** 英数字の語で、その連なりに数字が入っている(「23GB」「2」)。直後の助詞・漢字語を離さない。 */
  ascii: boolean;
  particle: boolean;
  open: boolean;
  space: boolean;
}

/** 直前の語と繋ぐか(繋ぐ=その間に折り目を作らない)。 */
function shouldGlue(piece: Piece, prev: Piece, run: number): boolean {
  if (prev.space) return false;
  if (piece.particle || CLOSER.test(piece.text)) return true; // 助詞・閉じ括弧は行頭に置かない
  if (piece.cjk && prev.open) return true; // 開き括弧だけが行末に残るのを防ぐ
  if (piece.cjk && prev.ascii) return true; // 「23GBの」「2誤り」は離さない
  if (!piece.cjk || !prev.cjk) return false;
  const breakHere = prev.particle && run >= MIN_BREAK_CHARS;
  return !breakHere && run + piece.text.length <= MAX_JOINED_CHARS;
}

/**
 * 題や本文の折り返し位置を語の区切りへ寄せる。日本語は語の間に空白が無いため、既定では
 * 「完了ボタ／ン」のように語の途中で割れる(2026-11-07 指摘)。CSS の `word-break: auto-phrase` は
 * 効かなかったので、語の中の字を WORD JOINER で繋いで語中に折り目を作らせない。
 *
 * 語の区切り(Intl.Segmenter)は「確かめ｜て」「注意｜帯」のように活用や熟語の途中でも切れるため、
 * **助詞・助動詞(ひらがなだけの語)の直後**だけを折り目にする。助詞の手前で折ると行頭が
 * 「て」「の」になり、熟語の途中で折ると「注意／帯」になるため、どちらも避ける。
 */
export function joinTitleWords(text: string): string {
  if (!WORD_SEGMENTER) return text;
  let out = "";
  let run = 0; // 直前に繋いだ語の字数
  let prev: Piece = {
    text: "",
    cjk: false,
    ascii: false,
    particle: false,
    open: false,
    space: true,
  };
  for (const part of WORD_SEGMENTER.segment(text)) {
    const s = part.segment;
    const word = part.isWordLike === true;
    const cjk = word && CJK_WORD.test(s);
    const piece: Piece = {
      text: s,
      cjk,
      ascii: word && !cjk && /[0-9A-Za-z]/.test(s),
      particle: cjk && HIRAGANA_ONLY.test(s),
      open: !word && OPENER.test(s),
      space: s.trim() === "",
    };
    const glue = shouldGlue(piece, prev, run);
    const inside = cjk && (s.length > 1 || piece.particle) ? Array.from(s).join(WORD_JOINER) : s;
    out += (glue ? WORD_JOINER : "") + inside;
    if (!cjk) {
      run = 0;
    } else if (glue) {
      run += s.length;
    } else {
      run = s.length;
    }
    // 「23」「GB」のように分かれて出てきても、間に空白が無ければ同じ英数字の連なりとみなす。
    if (piece.ascii) piece.ascii = prev.ascii || /[0-9]/.test(s);
    prev = piece;
  }
  return out;
}

/** 先頭に付いた台帳の整理番号(半角英数の4桁前後。例 `140c完了の確認`)。 */
const LEADING_CARD_ID = /^[0-9a-f]{3,8}(?=[^\s0-9a-f])/i;

/** 末尾の括弧つき番号(例 `完了の確認(#261)`)。 */
const TRAILING_NUMBER = /[（(]#?\d+[)）]\s*$/;

/** 題が「(リンク)」だけの行。中身がリンクだけの依頼で、題として読めない。 */
const LINK_ONLY = /^[（(]?\s*(リンク|link)\s*[)）]?$/i;

/**
 * 一覧に出す題を平易にする(2026-11-06 ユーザー指摘「内部ID風の語が出ている。平易な語へ」)。
 * 台帳の整理番号(`140c` など)と末尾の番号(`(#261)`)は画面では意味が読めないので落とす。
 * 落とした結果が空になるなら元の題をそのまま返す(題を消さない)。
 */
export function plainTitle(raw: string): string {
  const s = raw.trim();
  if (LINK_ONLY.test(s)) return "リンクの依頼";
  const cut = s.replace(LEADING_CARD_ID, "").replace(TRAILING_NUMBER, "").trim();
  return cut !== "" ? cut : s;
}

/** 担当の列に出す語。中身が英数のIDだけなら、そのまま出さず「担当のスレ」と言い換える。 */
export function plainAssignee(raw: string): string {
  const s = raw.trim();
  if (s === "") return "担当未定";
  return /^[0-9a-f]{6,}$/i.test(s) ? "担当のスレ" : s;
}

/** 一覧の上に出す注意書きの最大行数(2026-11-06 指摘「PC3行/iPhone4行ある。短く」)。 */
export const NOTICE_MAX_LINES = 2;

/** 注意書き(技術的な説明)を、画面で読める短い平易な行に直す規則。当たらなければ原文のまま。 */
const NOTICE_SHORT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/同じ鍵の依頼が\s*(\d+)\s*件/, (m) => `同じ依頼${m[1]}件は1つにまとめて表示`],
  [
    /日付の無い依頼\s*(\d+)\s*件.*日付を決められない/,
    (m) => `日付の分からない依頼${m[1]}件は非表示`,
  ],
  [
    /日付の無い依頼\s*(\d+)\s*件.*日付の印から/,
    (m) => `日付の分からない依頼${m[1]}件は前後の印から補完`,
  ],
];

/**
 * 注意書きを最大 `maxLines` 行に収める。溢れた分は最後の行に「ほかN件」と添える
 * (行を増やすと一覧の頭が埋まって、肝心の指示が見えなくなる)。
 *
 * `maxLines` を渡せるのは、切り詰めの注記(「全177件中 上位100件を表示」)と合わせて
 * 注意書き全体を2行に収めるため。呼び出し側が残りの行数を渡す。
 */
export function noticeLines(
  notices: readonly string[],
  maxLines: number = NOTICE_MAX_LINES,
): string[] {
  const lines = notices
    .map((n) => {
      for (const [re, short] of NOTICE_SHORT) {
        const m = n.match(re);
        if (m) return short(m);
      }
      return n.trim();
    })
    .filter((l) => l !== "");
  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) return lines;
  const shown = lines.slice(0, limit);
  const rest = lines.length - limit;
  shown[limit - 1] = `${shown[limit - 1]} ほか${rest}件`;
  return shown;
}
