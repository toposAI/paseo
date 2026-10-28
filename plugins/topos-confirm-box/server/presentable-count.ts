/**
 * サイドバー下部の「ユーザー判断」バッジ = **窓口Aがいま出せる件数**。
 *
 * 数えるのは判断窓口の Python 側(`antigravity/utils/judgment_window.py badge-count`)1か所だけ。
 * ここは呼んで数字を読むだけで、出せる/出せないの条件は書き写さない。
 * 2026-10-28 ユーザー「そしたらバッジださないでよ。そして開くとカードあったけど？」: バッジが open の
 * 総数を数えていたため、裏方が検討中の件など窓口Aが出さない件まで数え、開いても窓口に何も出ない
 * (逆に開くとカードがあった)状態が起きた。数える側と選ぶ側が別の条件なのが毎回の原因。
 *
 * 数字の意味: 窓口は1問ずつしか出さないので **1=次の `next` が1件返す / 0=出せるものがない**。
 * 0 のときバッジは出さない。null は「数えられない」(ノート置き場が見えない等)で、
 * 0 と区別して数字を出さない。
 *
 * 設定(どちらも未設定なら既定のチェックアウトをそのまま使う):
 * - TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR … ToposAI-Mini-Project のチェックアウトの根
 *   (既定: `~/repos/ToposAI-Mini-Project`。中に `antigravity/utils/judgment_window.py`)
 * - TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON  … 使う python(既定: macOS の CommandLineTools の python3)
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const DEFAULT_CLI_DIR = path.join(os.homedir(), "repos", "ToposAI-Mini-Project");
const CLI_TIMEOUT_MS = 10_000;
/** 数字を取り直す最短間隔。3か所(画面・ヘッダ・下部バー)が30秒毎に同じ数字を引くため */
const CACHE_MS = 10_000;

/** 窓口Aがいま出せる件数(1/0)を返す関数。null=数えられない(0件と区別する)。 */
export type PresentableRunner = () => Promise<number | null>;

/**
 * バッジの数字(presentable)を決める。**TS 側の集合(`open`)では 0 を確定しない**:
 * `open` は確認箱の行の集合で、窓口の候補(抱えたままの件など)と条件が違いうるため、`open` が空でも
 * 窓口は1件出せることがある(出口レビュー2巡目 指摘1)。Python を呼ばないのは「判断ノートを読まない設定」
 * のときだけ(その設定では窓口に出す件が無い)。
 * @param vaultEnabled 判断ノートを読む設定か。偽なら null(出す件が無い)
 * @param counter Python に聞く関数。無い(チェックアウトが無い)なり例外なら null(0件と偽らない)
 */
export async function computePresentable(
  vaultEnabled: boolean,
  counter: PresentableRunner | null,
): Promise<number | null> {
  if (!vaultEnabled || !counter) return null;
  try {
    return await counter();
  } catch {
    return null;
  }
}

/** 数字を返す関数。設定が解決できなければ null(=バッジは数字を出さない)。 */
export function resolvePresentableCounter(
  env: NodeJS.ProcessEnv = process.env,
): PresentableRunner | null {
  const dir = env.TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR?.trim() || DEFAULT_CLI_DIR;
  const script = path.join(path.resolve(dir), "antigravity", "utils", "judgment_window.py");
  if (!fs.existsSync(script)) return null;
  const python = env.TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON?.trim() || DEFAULT_PYTHON;
  return () =>
    new Promise((resolve) => {
      execFile(
        python,
        [script, "badge-count"],
        {
          cwd: path.dirname(script),
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
          // 画面を開いた時は待たせすぎない(取れなければ数字を出さないだけ)
          killSignal: "SIGKILL",
        },
        (error, stdout) => {
          try {
            // 1行だけの JSON。末尾の行を読む(警告が stderr に出ても壊れない)
            const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as {
              presentable?: unknown;
            };
            const v = parsed.presentable;
            if (v === null) return resolve(null);
            if (typeof v === "number" && Number.isInteger(v) && v >= 0) return resolve(v);
            resolve(null);
          } catch {
            resolve(null);
          }
        },
      );
    });
}

/**
 * 同じ数字を短時間キャッシュする(3か所が30秒毎に引くため、python の起動を1回にまとめる)。
 * 取り直し専用の経路は持たない(バッジは読むだけで、窓口の台帳を書かない)。
 */
export function cachedPresentableCounter(
  runner: PresentableRunner | null,
  cacheMs: number = CACHE_MS,
  now: () => number = Date.now,
): PresentableRunner | null {
  if (!runner) return null;
  let at = 0;
  let value: number | null = null;
  let inflight: Promise<number | null> | null = null;
  return () => {
    if (at && now() - at < cacheMs) return Promise.resolve(value);
    if (inflight) return inflight;
    inflight = runner()
      .then((v) => {
        at = now();
        value = v;
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
