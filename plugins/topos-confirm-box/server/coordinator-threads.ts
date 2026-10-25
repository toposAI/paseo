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
 * 生きているかは Paseo に聞くが、**落とすのはアーカイブ済みだけ**(2026-10-25: Paseo デーモンの再起動で
 * 走行中の司令塔が `status=closed`(未アーカイブ)になり、閉じた行を落とす旧設計だと上部の「司令塔」から
 * 消えて押せず、再開する手段も無かった)。`closed` の司令塔は行に残し、状態は機械状態 `closed` から
 * 「終了」と出す(`shared/thread-status-label.ts`)。押して送れば Paseo が再開する(`paseo send`)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChildThread, ThreadAccess } from "../shared/child-threads.js";

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
export function readGeneralCoordinatorId(stateDir: string = coordinatorStateDir()): string | null {
  try {
    const id = fs
      .readFileSync(path.join(stateDir, "domains", "general", "coordinator_id"), "utf8")
      .trim();
    return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

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
    // アーカイブ済みの司令塔は行にしない。全ページの一覧が取れない縮退時はアーカイブ込みの一覧へ
    // 落ちるので、古い `coordinator_id` を指す終わったスレが司令塔として先頭に出ていた(出口レビュー
    // round2 指摘7)。`closed` は落とさない(デーモン再起動で閉じただけの司令塔を消さない)。
    if (agent.archivedAt != null) continue;
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
      parentOpenable: false,
      access: null,
    });
  }
  return rows;
}

/**
 * 子を持つ親(グループ見出しになる `parentAgentId`)を開ける親として扱う。
 *
 * なぜ要るか(2026-10-24 ユーザー報告「子司令塔の見出しを押すと開かず開閉だけになる」): 見出しの押下で
 * 開くのは「`coordinator: true` の行がある親」だけだった。司令塔の行は起こしデーモンの
 * `coordinator_id` からしか作られず、子司令塔はそこに載らない。そのため、生きている子司令塔でも
 * 「開けない親」=開閉だけになっていた。ここではデーモンの一覧に居る(アーカイブされていない)親なら
 * `parentOpenable` を立てる。行そのものは増やさない(見出しは既にある `parentTitle`)。
 *
 * 一覧に居ない親(取得の隙間・範囲外)は立てない(開けない画面へ落とさない)。`coordinator` の印は
 * 変えない(「司令塔」グループへの寄せ方は呼び出し元の id 一覧が決める)。登録簿へは書き戻さない。
 */
export function markOpenableParents(
  rows: ChildThread[],
  agents: readonly CoordinatorAgent[],
  /**
   * 親を開けるか(`thread-liveness.ts` の判定)。アーカイブ済み・workspace-archived の親は開けない側に
   * 倒す。ただし**いまの呼び出し元は生存ワークスペースの id しか渡さない**ため、`workspace-archived`
   * は実際には付かない(出口レビュー round2 指摘2。既存の欠陥として残差に記録)。実際に効くのは
   * `a.archivedAt` と `status === "closed"` の2つ。
   * `agents` はアーカイブ済みを含まない全ページ版(`server/agent-pages.ts`)で渡される想定
   * (含まれて来ても `archivedAt` で落とす)。
   */
  access: ReadonlyMap<string, ThreadAccess> = new Map(),
): ChildThread[] {
  const alive = new Map<string, string>();
  for (const a of agents) {
    const id = str(a.id);
    if (!id || a.archivedAt != null || str(a.status) === "closed") continue;
    const canOpen = access.get(id);
    if (canOpen === "workspace-archived" || canOpen === "thread-archived") continue;
    alive.set(id, str(a.title));
  }
  return rows.map((t) => {
    const parent = t.parentAgentId;
    const title = parent === null ? undefined : alive.get(parent);
    if (parent === null || title === undefined) {
      return t.parentOpenable ? { ...t, parentOpenable: false } : t;
    }
    return {
      ...t,
      parentOpenable: true,
      parentTitle: title.trim() || t.parentTitle,
    };
  });
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
 * アーカイブ済みの司令塔の行を落とす(`closed` は残す。理由は冒頭コメント)。
 * ファイルの `coordinator_id` は起こしデーモンが書き換えるまで古い id を指し続けるので、
 * Paseo の一覧と突き合わせないと、アーカイブ済みの司令塔の行が一覧に残って押しても開けない
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
    return agent.archivedAt == null;
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
