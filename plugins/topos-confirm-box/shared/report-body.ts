/**
 * 報告書の本文を「Markdown のかたまり」と「画像」に分ける(純関数)。
 *
 * 画像にするのは次の2つだけ:
 *   - `![代替文](パス)` の行(パスは絶対 / ~/ 始まりで拡張子が画像)
 *   - 行全体が画像の絶対パス1つだけの行(箇条書きの印・バッククォート・括弧つきURLの添え書きは許す)
 * 文の途中に出てくる画像パスは画像にしない(本文を勝手に組み替えない)。
 * 実際に読めるか(許可範囲か)は画像を取るサーバー側(`allowedReportFile`)が決める。
 */
export type ReportSegment =
  | { id: string; t: "md"; text: string }
  | { id: string; t: "img"; path: string; alt: string };

const IMG_EXT = "(?:png|jpe?g|webp|gif)";
const MD_IMG = new RegExp(
  `^\\s*!\\[([^\\]]*)\\]\\(\\s*((?:~|/)[^)\\s]*\\.${IMG_EXT})\\s*\\)\\s*$`,
  "i",
);
const BARE = new RegExp(
  `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?\`?((?:~|/)[^\\s\`()]+\\.${IMG_EXT})\`?(?:\\s+\\(https?://[^)]*\\))?\\s*$`,
  "i",
);

export function splitReportBody(markdown: string): ReportSegment[] {
  const out: ReportSegment[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join("\n");
    if (text.trim()) out.push({ id: `m${out.length}`, t: "md", text });
    buf = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : (MD_IMG.exec(line) ?? null);
    const b = inFence || m ? null : BARE.exec(line);
    if (m) {
      flush();
      out.push({ id: `i${out.length}`, t: "img", path: m[2], alt: m[1] });
    } else if (b) {
      flush();
      out.push({ id: `i${out.length}`, t: "img", path: b[1], alt: "" });
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}
