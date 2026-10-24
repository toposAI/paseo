/**
 * 構想ノートの置き場(検討中 / あとで)の解決規則。**Node とブラウザの両方で読める**(fs を使わない)。
 *
 * 2026-10-24 ユーザー指示:「ObsidianVaultにPaseoってフォルダを作って。Paseo>構想>検討中とあとでを作って。
 * 検討中の構想をサイドバーに並べて」。置き場の**作成と移動の実装は別スレ**(単一ライター側)が持つ。
 * ここは「どのパスを見るか」だけを決め、読み出しの向きを1か所に閉じる:
 *
 * 1. `<Vault>/Paseo/構想/` が在れば新置き場: `検討中/` = 並べる、`あとで/` = 畳む。
 * 2. 無ければ(移行前)旧置き場: `05_Projects` の走査で見つかった構想ノート = 検討中。
 *    あとでは空(旧置き場に区分は無い)。
 *
 * どちらの置き場が使われたかは一覧の `place` で画面へ返す(「あとで」への移動を出せるかの判断材料)。
 *
 * **`node:path` は読まない**(プラグインの共有バンドルに Node のモジュールは組み込めない。
 * 2026-10-24 実測)。パス操作は `concept-paths.ts` の純関数を使う。
 */
import { dirnameOf, isAbsoluteOf, relativeOf } from "./concept-paths.js";

export const PASEO_DIR = "Paseo";
export const CONCEPT_DIR = "構想";
export const CONCEPT_ACTIVE_DIR = "検討中";
export const CONCEPT_LATER_DIR = "あとで";

/** 構想の区分(検討中=並べる / あとで=畳む)。 */
export type ConceptZone = "active" | "later";

export interface ConceptPlace {
  /** 新置き場(`Paseo/構想/`)の根。 */
  root: string;
  activeDir: string;
  laterDir: string;
}

/** パスを `/` でつなぐ(空の要素は落とす)。 */
function join(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

/** Vault の根から新置き場のパスを組む(`Paseo/構想/{検討中,あとで}`)。 */
export function conceptPlace(vaultDir: string): ConceptPlace {
  const root = join(vaultDir.replace(/\/+$/, "") || "/", PASEO_DIR, CONCEPT_DIR);
  return {
    root,
    activeDir: join(root, CONCEPT_ACTIVE_DIR),
    laterDir: join(root, CONCEPT_LATER_DIR),
  };
}

/**
 * ノートが区分のどちらにあるかを、パスの**区切り単位の前方一致**で判定する。
 * 文字列の `startsWith` だけだと `構想/検討中メモ/x.md` のような別ディレクトリを拾うので区切る。
 * どちらでもなければ null(新置き場の外=旧置き場のノート)。
 */
export function zoneOfPath(file: string, place: ConceptPlace): ConceptZone | null {
  // macOS のファイル名は NFD で返ることがあり、こちらが組んだ定数(検討中/あとで)は NFC。
  // 正規化しないと、同じディレクトリのノートを「置き場の外」と誤判定して移動できなくなる。
  const norm = (p: string) => p.normalize("NFC");
  const under = (dir: string) => {
    const rel = relativeOf(norm(dir), norm(file));
    return rel.length > 0 && !isOutside(rel);
  };
  if (under(place.laterDir)) return "later";
  if (under(place.activeDir)) return "active";
  return null;
}

/** `path.relative` の結果が外を指すか(`..` で始まる / 絶対パス)。 */
function isOutside(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || isAbsoluteOf(rel);
}

/**
 * ファイルが `dir` の**直下**にあるか(区切りの区別で、NFC に正規化して比べる)。
 * `dirname(file) === dir` は NFD のパスで false になりうるので、判定をここに閉じる。
 */
export function isDirectChild(file: string, dir: string): boolean {
  return dirnameOf(file.normalize("NFC")) === dir.normalize("NFC");
}

/**
 * 読み出しの向き(サーバーが `fs.existsSync` で作る)。`null` の区分は読まない・移動しない。
 * 新置き場が無い(`active === null`)= 旧置き場だけで動いている(移行前)。
 */
export interface ConceptReadPlan {
  active: string | null;
  later: string | null;
}

/** 画面へ返す帰結(`notesSidebarRpc` の `place`)。 */
export type SidebarPlace = "paseo" | "legacy";

export function placeName(plan: ConceptReadPlan): SidebarPlace {
  return plan.active === null ? "legacy" : "paseo";
}

/** 画面へ返す件数(`notesSidebarRpc` の `zones`)。`laterAvailable=false` なら「あとで」は出さない。 */
export interface ZoneCounts {
  active: number;
  later: number;
  laterAvailable: boolean;
}
