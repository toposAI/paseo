/**
 * バグ報告のスクリーンショットを data URI で読む。
 *
 * 報告JSONの `screenshot` は**ファイル名のみ**で、実体は `<feedbackDir>/screenshots/<name>`。
 * 名前は呼び出し側(画面)から来るので信用しない: basename 一致・画像拡張子・
 * realpath が `screenshots/` 配下・サイズ上限を全部検査する。
 */
import fs from "node:fs";
import path from "node:path";
import { MAX_BYTES } from "./reports.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
export const FEEDBACK_SCREENSHOT_MAX_BYTES = MAX_BYTES;

const NG = { ok: false, dataUri: "" } as const;

function readInDir(dir: string, name: string): string | null {
  try {
    const root = fs.realpathSync(path.join(dir, "screenshots"));
    const real = fs.realpathSync(path.join(root, name));
    if (!real.startsWith(root + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > FEEDBACK_SCREENSHOT_MAX_BYTES) return null;
    return fs.readFileSync(real).toString("base64");
  } catch {
    return null;
  }
}

export function readFeedbackScreenshot(
  name: string,
  dirs: readonly string[],
): { ok: boolean; dataUri: string } {
  if (!name || path.basename(name) !== name || name === "." || name === "..") return NG;
  const ext = path.extname(name).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return NG;
  for (const dir of dirs) {
    const b64 = readInDir(dir, name);
    if (b64 !== null) return { ok: true, dataUri: `data:${mime};base64,${b64}` };
  }
  return NG;
}
