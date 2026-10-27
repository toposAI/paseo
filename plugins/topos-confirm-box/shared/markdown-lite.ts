/**
 * 構想ノート閲覧用の小さな Markdown 解析(依存なし・React/Node 非依存)。
 *
 * 対応: 見出し / 段落 / 箇条書き・番号つき(入れ子は字下げ幅) / 引用 / コードブロック / 水平線 /
 * 表 / インライン(太字・斜体・`コード`・[[リンク]]・[文](URL))。Obsidian の独自記法のうち、
 * `![[画像]]` の埋め込みは文字として出さず「(埋め込み: 名前)」にする。解釈できない書き方は
 * 素の文字として出す(落とさない)。
 */

/** `id` は描画の key 用(並びの中で一意。JSX で配列の添字を key にしないため解析側で振る)。 */
export type Inline = { id: string } & (
  | { t: "text"; v: string }
  | { t: "bold"; v: string }
  | { t: "italic"; v: string }
  | { t: "code"; v: string }
  | { t: "wikilink"; target: string; label: string }
  | { t: "link"; href: string; label: string }
);

export interface ListItem {
  id: string;
  depth: number;
  marker: string;
  inl: Inline[];
}
export interface TableCell {
  id: string;
  inl: Inline[];
}
export interface TableRow {
  id: string;
  head: boolean;
  cells: TableCell[];
}

export type Block = { id: string } & (
  | { t: "heading"; level: number; inl: Inline[] }
  | { t: "para"; inl: Inline[] }
  | { t: "list"; items: ListItem[] }
  | { t: "quote"; inl: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  | { t: "table"; rows: TableRow[] }
);

const INLINE_RE =
  /!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])/g;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type InlineBody = WithoutId<Inline>;

function inlineOf(m: RegExpMatchArray): InlineBody {
  if (m[1] !== undefined) return { t: "text", v: `(埋め込み: ${m[1].split("|")[0]})` };
  if (m[2] !== undefined) {
    const [target, alias] = m[2].split("|");
    return {
      t: "wikilink",
      target: m[2],
      label: (alias ?? target.split("#")[0] ?? target).trim() || target,
    };
  }
  if (m[3] !== undefined) return { t: "link", href: m[4], label: m[3] };
  if (m[5] !== undefined) return { t: "bold", v: m[5] };
  if (m[6] !== undefined) return { t: "code", v: m[6] };
  return { t: "italic", v: m[7] };
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const push = (body: InlineBody) => out.push({ ...body, id: `i${out.length}` } as Inline);
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) push({ t: "text", v: src.slice(last, at) });
    push(inlineOf(m));
    last = at + m[0].length;
  }
  if (last < src.length) push({ t: "text", v: src.slice(last) });
  return out;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*(```|~~~)\s*(\S*)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s*>/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

type BlockBody = WithoutId<Block>;
/** 1ブロックの解析結果と、消費した最後の行の位置。 */
interface Parsed {
  block: BlockBody;
  end: number;
}

function parseFence(lines: string[], i: number, fence: RegExpExecArray): Parsed {
  const body: string[] = [];
  let k = i + 1;
  while (k < lines.length && !lines[k].trim().startsWith(fence[1])) body.push(lines[k++]);
  return { block: { t: "code", lang: fence[2], v: body.join("\n") }, end: k };
}

function parseTable(lines: string[], i: number): Parsed {
  const rows: TableRow[] = [];
  const add = (line: string) => {
    const r = rows.length;
    rows.push({
      id: `r${r}`,
      head: r === 0,
      cells: splitRow(line).map((c, k) => ({ id: `c${k}`, inl: parseInline(c) })),
    });
  };
  add(lines[i]);
  let k = i + 2;
  while (k < lines.length && lines[k].includes("|") && lines[k].trim() !== "") add(lines[k++]);
  return { block: { t: "table", rows }, end: k - 1 };
}

function parseQuote(lines: string[], i: number): Parsed {
  const q: string[] = [];
  let k = i;
  while (k < lines.length && QUOTE_RE.test(lines[k])) q.push(lines[k++].replace(/^\s*>\s?/, ""));
  return { block: { t: "quote", inl: parseInline(q.join(" ")) }, end: k - 1 };
}

function parseList(lines: string[], i: number): Parsed {
  const items: ListItem[] = [];
  let k = i;
  for (let m = LIST_RE.exec(lines[k]); m; m = k < lines.length ? LIST_RE.exec(lines[k]) : null) {
    const indent = m[1].replace(/\t/g, "    ").length;
    items.push({
      id: `l${items.length}`,
      depth: Math.min(Math.floor(indent / 2), 4),
      marker: /^\d/.test(m[2]) ? m[2] : "•",
      inl: parseInline(m[3]),
    });
    k++;
  }
  return { block: { t: "list", items }, end: k - 1 };
}

/** 段落以外の1ブロックを解く。段落の続き(どれにも当たらない行)なら null。 */
function parseSpecial(lines: string[], i: number): Parsed | null {
  const line = lines[i];
  const fence = FENCE_RE.exec(line);
  if (fence) return parseFence(lines, i, fence);
  const h = HEADING_RE.exec(line);
  if (h) return { block: { t: "heading", level: h[1].length, inl: parseInline(h[2]) }, end: i };
  if (HR_RE.test(line)) return { block: { t: "hr" }, end: i };
  if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
    return parseTable(lines, i);
  }
  if (QUOTE_RE.test(line)) return parseQuote(lines, i);
  if (LIST_RE.test(line)) return parseList(lines, i);
  return null;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const push = (body: BlockBody) => blocks.push({ ...body, id: `b${blocks.length}` } as Block);
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) push({ t: "para", inl: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      flush();
      continue;
    }
    const sp = parseSpecial(lines, i);
    if (sp) {
      flush();
      push(sp.block);
      i = sp.end;
    } else para.push(lines[i].trim());
  }
  flush();
  return blocks;
}
