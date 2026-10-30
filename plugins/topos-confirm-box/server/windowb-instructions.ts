/**
 * 窓口Bの指示の一覧を Python から引く(`antigravity/utils/window_b_instruction_panel.py` の CLI、JSON 1行)。
 * 確認箱のバッジ(`presentable-count.ts`)と同じ形: チェックアウトの場所と python を設定で変えられ、
 * 数秒キャッシュして、取れなければ例外(空の一覧として出さない)。
 *
 * 設定(どちらも未設定なら既定):
 * - TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR … ToposAI-Mini-Project のチェックアウトの根(確認箱と同じ設定を使う)
 * - TOPOS_WINDOWB_PANEL_PYTHON     … 使う python(既定: macOS の CommandLineTools の python3)
 *
 * スクリプトの有無は**呼ばれるたびに**見る。確認箱と同じくデーモンは長く動き続けるので、起動時に1回だけ
 * 決めると、後からスクリプトが入っても(チェックアウトを別ブランチにしてマージしても)再起動まで
 * 「読めない」に固定されてしまう。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WindowBInstructionsOutput } from "../shared/contract.js";

const DEFAULT_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const DEFAULT_CLI_DIR = path.join(os.homedir(), "repos", "ToposAI-Mini-Project");
const CLI_TIMEOUT_MS = 10_000;
/** 30秒毎の自動更新と手動の再読み込みが重ならないよう、短い間は同じ結果を返す。 */
const CACHE_MS = 8_000;

export type WindowBRunner = (limit: number) => Promise<WindowBInstructionsOutput>;

/** 使うスクリプトと python の場所(環境変数から)。 */
export function resolveWindowBScript(env: NodeJS.ProcessEnv = process.env): {
  script: string;
  python: string;
} {
  const dir = env.TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR?.trim() || DEFAULT_CLI_DIR;
  return {
    script: path.join(path.resolve(dir), "antigravity", "utils", "window_b_instruction_panel.py"),
    python: env.TOPOS_WINDOWB_PANEL_PYTHON?.trim() || DEFAULT_PYTHON,
  };
}

/**
 * 一覧を引く関数を作る。**作る時点ではスクリプトの有無を見ない**(無ければ呼んだときに例外)。
 * 例外の文には探したスクリプトのパスを入れる(「チェックアウトが無い」ではなく、何が無いのかを言う)。
 */
export function resolveWindowBRunner(env: NodeJS.ProcessEnv = process.env): WindowBRunner {
  const { script, python } = resolveWindowBScript(env);
  return (limit) =>
    new Promise((resolve, reject) => {
      if (!fs.existsSync(script)) {
        reject(new Error(`指示の一覧のスクリプトがありません(${script})`));
        return;
      }
      execFile(
        python,
        [script, "--limit", String(limit)],
        {
          cwd: path.dirname(script),
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          killSignal: "SIGKILL",
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            // 1行だけの JSON。標準出力に警告などが混ざっても壊れないよう、JSON として読める
            // 行のうち最後のものを読む。
            const lines = stdout.split("\n").map((l) => l.trim());
            const last = lines.findLast((l) => l.startsWith("{"));
            if (!last) throw new Error("window B instructions: no JSON line in output");
            resolve(JSON.parse(last) as WindowBInstructionsOutput);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      );
    });
}

/**
 * 同じ上限の結果を短時間キャッシュする(画面は30秒毎に引くので python の起動を1回にまとめる)。
 * **失敗はキャッシュしない**(スクリプトが後から入ったら次の呼び出しで読み直す)。
 */
export function cachedWindowBRunner(
  runner: WindowBRunner,
  cacheMs: number = CACHE_MS,
  now: () => number = Date.now,
): WindowBRunner {
  const cache = new Map<number, { at: number; value: WindowBInstructionsOutput }>();
  const inflight = new Map<number, Promise<WindowBInstructionsOutput>>();
  return (limit) => {
    const hit = cache.get(limit);
    if (hit && now() - hit.at < cacheMs) return Promise.resolve(hit.value);
    const running = inflight.get(limit);
    if (running) return running;
    const p = runner(limit)
      .then((v) => {
        cache.set(limit, { at: now(), value: v });
        return v;
      })
      .finally(() => inflight.delete(limit));
    inflight.set(limit, p);
    return p;
  };
}
