/**
 * パス文字列の小道具(**純関数だけ**。`node:path` を読まない)。
 *
 * 構想の置き場の規則はサーバーとブラウザの両方が読む `shared/concept-places.ts` に在るが、
 * そこに `node:path` を置くとプラグインの共有バンドルに組み込めず reload が落ちる
 * (2026-10-24 実測: `Node module cannot be imported into the plugin shared bundle: node:path`)。
 * よって POSIX のパス操作だけをここに書く(Vault のパスは POSIX 形式のみを扱う)。
 */

/** パスの「/」区切りを畳む(`//` を1つに、末尾の `/` を落とす)。 */
function crunch(file: string): string {
  const out = file.replace(/\/{2,}/g, "/");
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
}

/** `path.dirname` と同じ(区切りの最後の `/` より前。無ければ `.`)。 */
export function dirnameOf(file: string): string {
  const p = crunch(file);
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : p.slice(0, i);
}

/** `path.relative(base, to)` と同じ(`..` と `.` の正規化・先頭の `/` は見ない)。 */
export function relativeOf(base: string, to: string): string {
  const parts = (p: string) => {
    const normalized = normalizeOf(p);
    return normalized === "/" ? [] : normalized.replace(/^\//, "").split("/").filter(Boolean);
  };
  const a = parts(base);
  const b = parts(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** `path.normalize` の POSIX 版(連続 `/` を畳む・`.` を外す・`..` を畳む・末尾の `/` を残す)。 */
export function normalizeOf(file: string): string {
  const absolute = file.startsWith("/");
  const trailing = file.length > 1 && file.endsWith("/");
  const out: string[] = [];
  for (const seg of file.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (seg === ".." && absolute) continue;
    else out.push(seg);
  }
  const body = out.join("/");
  if (absolute) return `/${body}${trailing && body ? "/" : ""}`;
  return `${body || "."}${trailing && body ? "/" : ""}`;
}

/** `path.isAbsolute` の POSIX 版。 */
export function isAbsoluteOf(file: string): boolean {
  return file.startsWith("/");
}
