/**
 * 完了箱C(完了報告の窓口)の行に**未読**を出す。
 *
 * 背景(2026-10-26 ユーザー依頼): 「完了箱Cも新しい完了報告が入ったら…印を付けて、表示もそうして」
 * 「読み終えたら(既読位置が最新に追いついたら)印を消して『待機中』に戻す」。
 * 橙は**判断待ち(窓口A/A')専用**にする決定(同日 窓口B)なので、こちらは新着と同じ緑を使う
 * (点=緑の「新着」、行末の帯=「未読あり」)。
 *
 * 既読の判定は**Paseo の attention をそのまま使う**(プラグイン側に自前の既読位置を持たない):
 * `requiresAttention` はそのスレのターンが終わってから、利用者がそのスレを開く/入力する/離れるまで
 * 立っていて、読むと `clearAgentAttention` で消える
 * (`packages/app/src/hooks/use-agent-attention-clear.ts`)。自前のカーソルを持つと
 * 「利用者が読んだ」ことを窓口側から観測できず、印が消えないまま残る。
 *
 * 対象は `progress_window/window_id` が指す1本だけ(他のスレの新着は従来どおり点だけ)。
 * 未読でないときは帯を `待機中` に戻す: この窓口は待機が正常な状態なのに、登録簿の
 * `status` が語彙外(例 `待機`)で「実装中」と出ていた(ユーザー依頼の「待機中に戻す」)。
 *
 * 分からないときは**動かさない**(一覧に居ない・id を読めない → 行はそのまま)。推測で
 * 未読を消すと「読んだことにされる」側へ倒れるため。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChildThread } from "../shared/child-threads.js";
import type { ListedAgentLike } from "./unregistered-threads.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 完了報告の窓口の状態ディレクトリ(正本: `antigravity/utils/toposai_paths.py` の `progress_window_dir`)。 */
export function progressWindowDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PROGRESS_WINDOW_DIR ||
    path.join(os.homedir(), ".local", "state", "toposai", "progress_window")
  );
}

/** 窓口の agent id(短縮形。`03aeafd` のような7桁)。読めない/形が違うときは null。 */
export function readWindowId(dir: string = progressWindowDir()): string | null {
  try {
    const id = fs.readFileSync(path.join(dir, "window_id"), "utf8").split("\n")[0]?.trim();
    return id && /^[A-Za-z0-9-]{7,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * 「読み終えていない結果を持つ窓口」か。Paseo の attention の材料だけで決める
 * (`shared/state-dot.ts` の `deriveStateDot` と同じ順序の考え方)。
 *
 * - 承認待ち(`permission`)と失敗(`error`)は別の色が担当するので未読にしない(橙・赤を奪わない)。
 * - 実行中(`running`/`initializing`)はまだ結果が出ていないので未読にしない。
 */
export function isUnreadWindow(agent: ListedAgentLike | undefined): boolean {
  if (!agent || agent.requiresAttention !== true) return false;
  const reason = str(agent.attentionReason);
  if (reason === "permission" || reason === "error") return false;
  const state = str(agent.status);
  if (state === "running" || state === "initializing") return false;
  return true;
}

/**
 * 窓口の行だけ、未読の印と帯の語彙を揃える。
 *
 * - 未読: `unread=true` + 点を緑(新着)に。帯の文字は画面側が「未読あり」にする。
 * - 既読: `unread=false` + 帯を `待機中` に(完了の行は下げない)。
 * - 窓口が実行中: 何もしない(報告を書いている最中は「実装中」が正しい)。
 * - 窓口が一覧に居ない/`window_id` が読めない: 何もしない(推測しない)。
 *
 * 変化の無い行は同じ参照のまま返す(数秒ごとの取得で再描画を増やさない)。
 */
export function applyWindowUnread(
  rows: readonly ChildThread[],
  agents: readonly ListedAgentLike[],
  windowId: string | null,
): ChildThread[] {
  if (!windowId) return [...rows];
  // `window_id` は短縮形(先頭7桁)。突き合わせは既存の規約と同じ前方一致
  // (`completion_reporter.alive` も `agent_id[:7]` で見る)。
  const key = windowId.slice(0, 7);
  const agent = agents.find((a) => str(a.id).startsWith(key));
  if (!agent) return [...rows];
  const state = str(agent.status);
  if (state === "running" || state === "initializing") return [...rows];
  const unread = isUnreadWindow(agent);
  return rows.map((t) => {
    if (!t.agentId.startsWith(key)) return t;
    const status: ChildThread["status"] = t.status === "完了" ? t.status : "待機中";
    const stateDot = unread ? ("attention" as const) : (t.stateDot ?? null);
    if (t.unread === unread && t.status === status && t.stateDot === stateDot) return t;
    return { ...t, unread, status, stateDot };
  });
}
