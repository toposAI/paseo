/**
 * 構想タブの1行の表示材料(純粋関数だけ。RN を読み込まずに単体テストする)。
 *
 * 2026-10-24 ユーザー指示:
 * - 「構想スレの題名も要約してほしい」→ 行の題名は**1行に収まる長さへ決定的に短縮**する
 *   (LLM を呼ばない。一覧を出すたびに課金と待ちが増えないよう、切り詰めだけにする)。
 * - 「構想(スレ未作成)が場所を取りすぎ。構想の表示は不要。スレ未作成かどうかはアイコンで」
 *   → 行右端の状態文字は**出さない**。スレの有無は小さなアイコン(`conceptThreadBadge`)だけで示す。
 */
import type { ConceptZone } from "./concept-places.js";
import type { SidebarNote } from "./notes.js";

/** 行の題名の上限(サイドバー幅 320px 前後で1行に収まる目安。全角1文字 ≒ 13px)。 */
export const ROW_TITLE_MAX = 24;

/** 改行・連続空白を1つに潰して `max` 文字で切る(超えたら `…` を付ける)。 */
export function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  // コードポイント単位で切る(絵文字を半分にしない)。
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : t;
}

/** 構想ノートの題名を1行用に短縮する(frontmatter の題名だけを使う。本文は読まない)。 */
export function conceptRowTitle(note: Pick<SidebarNote, "title">): string {
  return shorten(note.title, ROW_TITLE_MAX);
}

/** 長押しで見せる全文(`Row` の長押し表示。題名を切っても元の題名を確かめられる)。 */
export function conceptRowFullLabel(note: Pick<SidebarNote, "title" | "conclusion">): string {
  return note.conclusion ? `${note.title} — ${shorten(note.conclusion, 80)}` : note.title;
}

/**
 * 構想タブの区分(見出しを出すか・畳めるか)。
 *
 * 旧置き場(`place: "legacy"`)は普段は平らに並べるが、「あとで」にノートが在れば見出しだけは出す
 * (消した区分に残ったノートを見えなくしない)。
 * 新置き場では「検討中」の一覧の下に「あとで」の畳んだフォルダ風の見出しを1行だけ置く。
 * 見出しは**片方の置き場だけでも出す**(移行の途中で「あとで」に移した分が消えて見えない)。
 */
export interface ConceptSections {
  /** 「あとで」の見出しを出すか(新置き場のとき)。 */
  showLater: boolean;
  /** 見出しを押して中身を開けるか(両方の置き場が在って移動もできるとき)。 */
  laterToggle: boolean;
}

export function conceptSections(
  place: "paseo" | "legacy",
  zones: { later: number; laterAvailable: boolean },
): ConceptSections {
  // 旧置き場でも「あとで」にノートがあれば見出しを出す(`検討中/` を消した等の移行の途中で、
  // 「あとで」のノートがどの区分にも出ずに見えなくなるのを避ける)。移せないので畳みもできない。
  if (place === "legacy") return { showLater: zones.later > 0, laterToggle: false };
  // 見出しは「あとで」に1件でも入っているか、区分が在るときだけ出す
  // (旧置き場から移行して0件のときに、空のフォルダだけが残らないように)。
  return { showLater: zones.laterAvailable || zones.later > 0, laterToggle: zones.laterAvailable };
}

/**
 * スレとの結び付き(行右端の小さなアイコンで示す。文字は出さない)。
 * - `thread`: 開けるスレがある(アイコンを出さない = 既定の見た目)。
 * - `unresolved`: ノートにスレIDは書かれているが解決できない(アーカイブ済み・短縮形など)。
 * - `none`: スレがまだ無い(タップすると作る)。
 */
export type ConceptThreadBadge = "thread" | "unresolved" | "none";

export function conceptThreadBadge(
  note: Pick<SidebarNote, "threadId" | "threadCandidates">,
): ConceptThreadBadge {
  if (note.threadId) return "thread";
  return note.threadCandidates.length > 0 ? "unresolved" : "none";
}

/**
 * アイコンの説明(吹き出しと読み上げのラベル)。
 * SDK に Tooltip が無いので、画面は色の違い+**押した後に出る1行の説明**で示す
 * (`client/ConceptNotes.tsx` の `ConceptRow`。どこか1つでも説明が出れば全体の意味が分かる)。
 */
export function conceptThreadBadgeLabel(badge: ConceptThreadBadge): string {
  switch (badge) {
    case "thread":
      return "スレ作成済み(タップで開く)";
    case "unresolved":
      return "スレ未解決(書かれたスレIDが見つからない。タップで作り直し)";
    default:
      return "スレ未作成(タップで深掘りのスレを作る)";
  }
}

/** 「あとで」の見出し(畳んだ小さなフォルダ風)。件数だけ出す。 */
export function laterSectionLabel(count: number): string {
  return count === 0 ? "あとで(なし)" : `あとで ${count}件`;
}

/** 「あとで」の行メニューの文言(向きによって変える)。 */
export function deferMenuLabel(zone: ConceptZone): string {
  return zone === "active" ? "あとで(今は見ない)" : "検討中に戻す";
}
