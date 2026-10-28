/**
 * 構想ノート編集の変更履歴 = Topos の VaultHistory(本人 Vault のローカル git。git-dir は Vault の外)。
 *
 * Paseo 独自の控えは持たない(2026-10-28 ユーザー決定)。Topos の保存と同じ履歴・同じキュー・同じ
 * PHI 除外に積むため、履歴の判断はすべて Topos 側の小さな CLI(`backend/tools/vault_history_commit.py`)に任せ、
 * ここは「呼んで結果の state を読む」だけ。
 *
 * 設定(どれも未設定なら**履歴なし=編集は無効**。履歴なしの上書きは許さない):
 * - TOPOS_CONFIRM_BOX_VAULT_HISTORY_CLI_DIR … Topos のチェックアウトの根(中に backend/tools/vault_history_commit.py)
 * - TOPOS_CONFIRM_BOX_VAULT_HISTORY_PYTHON  … 使う python(既定: macOS の CommandLineTools の python3)
 * - TOPOS_CONFIRM_BOX_VAULT_HISTORY_USER    … 履歴の持ち主(既定: owner。Topos 本人版の保存と同じ git-dir になる)
 * - TOPOS_CONFIRM_BOX_VAULT_HISTORY_GIT_DIR … git-dir を直接指定(テスト用)
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type HistoryState =
  | "committed"
  | "already"
  | "excluded"
  | "not_committed"
  | "unknown"
  | "unavailable";

export type HistoryPhase = "pre" | "post";

/** rel(Vault 相対・/ 区切り)の今のファイルを履歴へ1コミット積み、結果の state を返す。 */
export interface HistoryCommitter {
  commit(vaultRoot: string, rel: string, phase: HistoryPhase): Promise<HistoryState>;
}

const STATES: ReadonlySet<string> = new Set([
  "committed",
  "already",
  "excluded",
  "not_committed",
  "unknown",
  "unavailable",
]);
const DEFAULT_PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const CLI_TIMEOUT_MS = 60_000;

/** 設定が揃っていれば CLI を呼ぶ committer を返す。揃っていなければ null(編集は無効)。 */
export function resolveHistoryCommitter(
  env: NodeJS.ProcessEnv = process.env,
): HistoryCommitter | null {
  const dir = env.TOPOS_CONFIRM_BOX_VAULT_HISTORY_CLI_DIR?.trim();
  if (!dir) return null;
  const script = path.join(path.resolve(dir), "backend", "tools", "vault_history_commit.py");
  if (!fs.existsSync(script)) return null;
  const python = env.TOPOS_CONFIRM_BOX_VAULT_HISTORY_PYTHON?.trim() || DEFAULT_PYTHON;
  const user = env.TOPOS_CONFIRM_BOX_VAULT_HISTORY_USER?.trim() || "owner";
  const gitDir = env.TOPOS_CONFIRM_BOX_VAULT_HISTORY_GIT_DIR?.trim() || "";
  const cwd = path.resolve(dir);
  return {
    commit: (vaultRoot, rel, phase) =>
      new Promise<HistoryState>((resolve) => {
        const args = [
          script,
          "commit",
          "--vault",
          vaultRoot,
          "--path",
          rel,
          "--user-id",
          user,
          "--actor",
          "paseo",
          "--phase",
          phase,
        ];
        if (gitDir) args.push("--git-dir", gitDir);
        execFile(
          python,
          args,
          { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 },
          (error, stdout) => {
            // 起動できない・時間切れは「積めたか分からない」。成功とは読まない。
            if (error && !stdout) return resolve("unknown");
            try {
              const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as {
                state?: string;
              };
              resolve(
                parsed.state && STATES.has(parsed.state)
                  ? (parsed.state as HistoryState)
                  : "unknown",
              );
            } catch {
              resolve("unknown");
            }
          },
        );
      }),
  };
}

export function historyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveHistoryCommitter(env) !== null;
}

export const HISTORY_OFF_MESSAGE =
  "変更履歴(Topos のローカル git)が設定されていないため編集できません";
