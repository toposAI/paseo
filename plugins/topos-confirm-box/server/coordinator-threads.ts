/**
 * 司令塔スレ(総司令・子司令塔)をサイドバーの行として出すための材料。
 *
 * なぜ要るか(2026-10-23): サイドバーの一覧は登録簿 `child_threads.json` だけを読む。登録簿は
 * `child_thread_registry.sync` が「cwd に `_coordinator-spawned` を含むスレ」を登録するため、
 * **司令塔自身は登録されない**(司令塔の cwd はリポジトリルート)。司令塔が一覧に出ていたのは、
 * その子スレの `parent_agent_id` がグループ見出しになっていたからで、**子を1本も持たない
 * 司令塔は原理的に出ない**。実際 2026-10-23 に新しい総司令へ切り替わった直後、子が居ないため
 * サイドバーから開けなくなった(ユーザー「このスレが自作サイドバーに出ない」)。
 *
 * 司令塔の一覧はデーモンが持つ実行時の正本(`<state>/domains/<領域>/coordinator_id`)から読む。
 * 生きているかは Paseo に聞く(閉じた司令塔を出さない)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChildThread } from "../shared/child-threads.js";

/** 起こしデーモンの状態ディレクトリ(正本: `antigravity/utils/coordinator_wakeup_daemon.py` の `STATE_DIR`)。 */
export function coordinatorStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.COORDINATOR_WAKEUP_STATE_DIR ||
    path.join(os.homedir(), ".local", "state", "toposai", "coordinator_wakeup_daemon")
  );
}

/**
 * 生きている司令塔の agent id(領域ごとに1本。重複は畳む)。
 * ファイルが無い/読めない領域は黙って飛ばす(一覧そのものは止めない)。
 */
export function readCoordinatorIds(stateDir: string = coordinatorStateDir()): string[] {
  const base = path.join(stateDir, "domains");
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const name of names.sort()) {
    try {
      const id = fs.readFileSync(path.join(base, name, "coordinator_id"), "utf8").trim();
      if (/^[A-Za-z0-9-]{8,64}$/.test(id)) ids.add(id);
    } catch {
      continue;
    }
  }
  return [...ids];
}

/** `ctx.paseo.agents.list()` の要素(Paseo 側の型に依存しないよう、読む所だけ緩く持つ)。 */
export interface CoordinatorAgent {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  archivedAt?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 司令塔の行を作る。**既に登録簿の行として出ている id は除く**(行が二重にならないよう)。
 * 司令塔の一覧は呼び出し側が先頭に置き、子スレの `parentAgentId` はこの一覧の id へ揃える。
 */
export function coordinatorRows(
  ids: readonly string[],
  agents: readonly CoordinatorAgent[],
  existing: readonly ChildThread[],
): ChildThread[] {
  const shown = new Set(existing.map((t) => t.agentId));
  const rows: ChildThread[] = [];
  for (const id of ids) {
    if (shown.has(id)) continue;
    const agent = agents.find((a) => str(a.id) === id);
    if (!agent) continue;
    rows.push({
      agentId: id,
      title: str(agent.title) || id.slice(0, 8),
      // 司令塔は「完了」を持たない(交代で閉じる)。意味のある状態は実装中のまま、機械状態だけ持つ。
      status: "実装中",
      machineState: str(agent.status) || null,
      request: "司令塔スレ(常時表示)",
      summaryItemId: null,
      summary: null,
      summaryState: null,
      summaryAcked: false,
      updatedAt: 0,
      parentAgentId: null,
      parentTitle: null,
      pinned: false,
      coordinator: true,
      access: null,
    });
  }
  return rows;
}

/**
 * 登録簿に既に載っている司令塔(例: 司令塔が自分で建てた子スレの一覧に自分も入っている場合)へ
 * `coordinator` の印を付ける。印が無いと「その他」へ落ちて状態ラベル付きで出てしまう。
 */
export function markCoordinators(rows: ChildThread[], ids: readonly string[]): ChildThread[] {
  const known = new Set(ids);
  return rows.map((t) =>
    t.coordinator === true || !known.has(t.agentId) ? t : { ...t, coordinator: true },
  );
}

/**
 * 生きていない司令塔(closed/アーカイブ済み)の行を落とす。
 * ファイルの `coordinator_id` は起こしデーモンが書き換えるまで古い id を指し続けるので、
 * Paseo の一覧と突き合わせないと、閉じた司令塔の行が一覧に残って押しても開けない
 * (2026-10-23 ユーザー報告「タップしてもスレが開かない」の一因)。
 * 一覧に居ない id(範囲外・取得の隙間)は落とさない(消す側に倒さない)。
 */
export function dropDeadCoordinators(
  rows: ChildThread[],
  agents: readonly CoordinatorAgent[],
): ChildThread[] {
  const byId = new Map(agents.map((a) => [str(a.id), a]));
  return rows.filter((t) => {
    if (t.coordinator !== true) return true;
    const agent = byId.get(t.agentId);
    if (!agent) return true;
    return str(agent.status) !== "closed" && agent.archivedAt == null;
  });
}

/**
 * 司令塔の子スレ(登録簿で親なし=「その他」に行くもの)を、司令塔の下へ寄せる。
 *
 * `child_thread_registry.sync` は cwd が `_coordinator-spawned` のスレしか登録せず、親は登録時にしか
 * 引かない。総司令を `--cwd _coordinator-spawned` で起こすと子スレも同じ場所で生まれ、親の分からない
 * 行として「その他」に落ちていた。**司令塔の行(`coordinator: true`)が1本だけ**のとき、親なしの行を
 * その司令塔の下へ寄せる。複数の司令塔が居る場合は誰の子か推測できないので何もしない。
 */
export function adoptOrphans(rows: ChildThread[]): ChildThread[] {
  const hosts = rows.filter((t) => t.coordinator === true);
  if (hosts.length !== 1) return rows;
  const host = hosts[0];
  return rows.map((t) =>
    t.coordinator === true || t.parentAgentId !== null
      ? t
      : { ...t, parentAgentId: host.agentId, parentTitle: host.title },
  );
}
