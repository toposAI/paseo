/**
 * カードの見出しと画像の下の説明文の整え方(ce91 の表示差し戻し)。
 * 「(2/2枚目)」は折り返し・省略で欠けると何枚目か分からなくなるので、見出し本体と分けて必ず残す。
 */

const COUNT_SUFFIX = /\s*[((]\s*\d+\s*\/\s*\d+\s*枚目\s*[))]\s*$/;

export interface SplitTitle {
  title: string;
  /** 「(2/2枚目)」。無ければ空文字。 */
  suffix: string;
}

export function splitShotCount(subject: string): SplitTitle {
  const m = COUNT_SUFFIX.exec(subject);
  if (!m) return { title: subject, suffix: "" };
  return { title: subject.slice(0, m.index).trimEnd(), suffix: m[0].trim() };
}

const squash = (s: string): string => splitShotCount(s).title.replace(/\s+/g, "").toLowerCase();

/** 画像の下の説明文。見出しと同じ(枚数表記を除いて)なら出さない(null)。 */
export function captionToShow(caption: string | undefined, subject: string): string | null {
  const c = (caption ?? "").trim();
  if (!c) return null;
  return squash(c) === squash(subject) ? null : c;
}

/**
 * カード見出しの上限文字数(異常に長い題の歯止め)。通常はここまで届かない。
 * 幅に応じた省略は描画側の行数上限(numberOfLines)に任せる: 文字数で切ると
 * PC幅では2行目の頭だけが残り、iPhone幅では逆に早く切れて、幅ごとに見え方が食い違う
 * (2026-11-08 ui-visual-check の差し戻し)。
 */
export const HEADING_MAX = 80;

/**
 * iPhone幅(1行およそ20字)で2行に収まる目安の字数。これを超えたら読点で畳む。
 * 畳めたときの結果は「…」込みで最長 44 字。読点も助詞も無い題は畳めずに残り、
 * HEADING_MAX の歯止め(80字)まで伸びるので、幅の狭い端末では3行になり得る
 * (どちらも描画側の numberOfLines=3 で受ける)。行数任せにすると、語の区切り
 * (CJK は助詞の直後しか折れない)の都合で行の右端が 280/171/319 のようにギザギザになり
 * 「変なところで改行」に見えたため、字数で畳んでから描かせる
 * (2026-11-08 ui-visual-check の差し戻し)。
 */
export const HEADING_SOFT = 42;

/** 見出しとして意味を持つ最小の長さ。これ未満では切らない。 */
const MIN_HEAD_CHARS = 12;

/**
 * カードの見出し用に題を短くする(2026-11-08 ユーザー指摘「確認箱のカードの題名が長過ぎない？」)。
 * 投函側(confirm_box_askq.py)は複数の質問を「 / 」(前後に空白)でつないで1つの題にすることが
 * あり、そのまま出すと見出しが画面の大半を占めて末尾も途中で切れる。最初の1問だけを出し、
 * 文の切れ目で止める。それでも2行に収まらない長さは読点(なければ語の切れ目)で畳み、
 * 末尾に「…」を付ける。2問目以降はカードのチャット欄・背景・通知・優先度画面で読める。
 */
export function headingText(raw: string): string {
  const s = splitShotCount(raw).title.trim();
  if (s === "") return s;
  // 「 / 」で複数の質問がつながっているときは最初の1問だけを出す。
  // ただし最初の1問が短すぎるときは切らない(「PC / iPhone の表示幅をそろえる案」が
  // 「PC」だけになる。区切りの「 / 」は質問の区切りとは限らない)。
  const parts = s.split(/\s+\/\s+/);
  let head = parts.length > 1 && parts[0].trim().length >= MIN_HEAD_CHARS ? parts[0].trim() : s;
  // 最初の文の終わり(。？！!)までを1つの見出しとみなす。12字目より前で終わる文なら
  // 切らずに題をそのまま残す(長さは後段の畳みで抑える)。
  const m = /[。？！?!]/.exec(head);
  if (m && m.index >= MIN_HEAD_CHARS) head = head.slice(0, m.index + 1);
  if (head.length > HEADING_SOFT) head = foldAtClause(head, HEADING_SOFT);
  // 絵文字が半分に割れないよう、コード単位ではなく文字単位で切る。
  const chars = Array.from(head);
  if (chars.length > HEADING_MAX)
    head =
      chars
        .slice(0, HEADING_MAX - 1)
        .join("")
        .trimEnd() + "…";
  return head;
}

/**
 * `limit` 字を超える題を、上限より前の**最後の読点**で畳む(読点が無ければ語の切れ目のうち
 * 一番後ろ)。文の途中で切ったことが分かるよう「…」を付ける。切る位置が浅すぎる(12字未満)
 * ときは畳まず、描画側の行数上限に任せる。
 */
function foldAtClause(s: string, limit: number): string {
  const cut = s.slice(0, limit + 1);
  const comma = cut.lastIndexOf("、");
  if (comma >= MIN_HEAD_CHARS) return s.slice(0, comma + 1).trimEnd() + "…";
  // 読点が無い題は、助詞の直後(語の切れ目)で畳む。分節は joinTitleWords と同じ考え方。
  let last = -1;
  for (let i = MIN_HEAD_CHARS; i < cut.length; i++) if (PARTICLE_AFTER.has(cut[i])) last = i;
  if (last >= MIN_HEAD_CHARS) return s.slice(0, last + 1).trimEnd() + "…";
  return s;
}

/** 直後で折っても読みやすい助詞(ひらがな1字)。 */
const PARTICLE_AFTER = new Set(Array.from("はがをにでともへやの"));

/** 縦長画像の描画上限。幅いっぱいに描き、これより縦に長い分は切る(全画面と拡大で細部を見る)。 */
export const SHOT_MAX_HEIGHT = 520;
/** 画像の大きさが分かる前の仮の縦横比(枠の高さがガタつきすぎないように)。 */
export const SHOT_FALLBACK_RATIO = 1.6;

/** 画像の縦横比(幅/高さ)。壊れた値は仮の比に落とす。 */
export function shotRatio(width: number, height: number): number {
  return width > 0 && height > 0 ? width / height : SHOT_FALLBACK_RATIO;
}
