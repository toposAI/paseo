/**
 * サイドバーの `closed`(閉じた)スレの扱い(2026-10-28 ユーザー依頼「終了って判定できるならサイドバーから
 * けして。判断窓口A'は待機中でしょ。でも残しておいて」「裏方Opusはサイドバーにも表示しなくていい」)。
 *
 * - 中核スレ(司令塔・窓口A/A'/B・完了箱C)は閉じても消さず、**「終了」でなく「待機中」**と出す
 *   (デーモン再起動で閉じただけで、押して送れば Paseo が再開する)。
 * - 中核でない `closed` のうち、**本当に終わったと判る行**だけ外す: 登録簿で `完了` の行、登録簿に
 *   載らない行(機械状態から導いた `待機中`)。登録簿で「実装中」のまま閉じた行は止まった作業なので
 *   外さず、従来どおり「終了」と出す(ユーザー決定 2026-10-28)。
 * - 非表示の id は行を作る段階で外すだけ。メッセージ送信・通知・`paseo ls` には触れない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChildThread } from "../shared/child-threads.js";

const ID_RE = /^[A-Za-z0-9-]{7,64}$/;

function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOPOSAI_STATE_DIR || path.join(os.homedir(), ".local", "state", "toposai");
}

function readIdLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter((l) => ID_RE.test(l));
  } catch {
    return [];
  }
}

/** 窓口A'・B など(`judgment_window/windows/*.id`)と完了箱C(`progress_window/window_id`)の id。 */
export function readCoreWindowIds(dir: string = stateDir()): string[] {
  const ids: string[] = [];
  try {
    const winDir = path.join(dir, "judgment_window", "windows");
    for (const f of fs.readdirSync(winDir)) {
      if (f.endsWith(".id")) ids.push(...readIdLines(path.join(winDir, f)).slice(0, 1));
    }
  } catch {
    // 無ければ空
  }
  ids.push(...readIdLines(path.join(dir, "progress_window", "window_id")).slice(0, 1));
  // 窓口A など上の2か所に登録が無い中核スレ(1行1id・`#` コメント可)。
  ids.push(...readIdLines(path.join(dir, "sidebar_core_agent_ids.txt")));
  return ids;
}

/** サイドバーに出さない agent id(1行1id・`#` コメント可)。無ければ空。 */
export function readSidebarHiddenIds(dir: string = stateDir()): string[] {
  return readIdLines(path.join(dir, "sidebar_hidden_agent_ids.txt"));
}

/**
 * サイドバーの**一番上に固定する行**の id(2026-11-01 ユーザー指示「判断窓口Aをピン止めの一番上に」)。
 *
 * 判断窓口A は乗り換えのたびに agent id が変わる(`scripts/spawn_judgment_windows.sh` が
 * `judgment_window/windows/A.id` を書き換える)。**id ではなく役で引く**ので、乗り換え直後から
 * 新しいスレが同じ場所(先頭)に来る。`sidebar_top_agent_ids.txt`(1行1id・`#` コメント可)で足せる。
 */
export function readSidebarTopAgentIds(dir: string = stateDir()): string[] {
  return [
    ...readIdLines(path.join(dir, "judgment_window", "windows", "A.id")).slice(0, 1),
    ...readIdLines(path.join(dir, "sidebar_top_agent_ids.txt")),
  ];
}

/**
 * 指定 id の行を一覧の先頭へ移す(残りの相対順はそのまま)。
 *
 * 保存した並び順(`child_threads_order.json`)に無い新しい id は末尾に置かれる規則なので、
 * 乗り換え直後の窓口Aは必ず一番下に出る。役で先頭へ寄せて、乗り換え直後でも先頭に来るようにする。
 *
 * `placedIds`(保存順に入っている id)に居る行は寄せない。**ユーザーがドラッグして決めた位置を
 * 上書きしない**ため(寄せ続けると、下へ動かしても毎回先頭へ跳ね返る=元の不具合の繰り返し)。
 * 役の id が保存順に無いとき(=乗り換え直後・初回)だけ先頭に置く。
 */
export function hoistRowsToTop<T extends { agentId: string }>(
  rows: readonly T[],
  topIds: readonly string[],
  placedIds: readonly string[] = [],
): T[] {
  if (topIds.length === 0 || rows.length < 2) return [...rows];
  const head: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    const hoist = matchesAny(row.agentId, topIds) && !matchesAny(row.agentId, placedIds);
    (hoist ? head : rest).push(row);
  }
  return [...head, ...rest];
}

/** id が一覧のどれかに一致するか(短縮形は先頭一致)。 */
function matchesAny(agentId: string, ids: readonly string[]): boolean {
  return ids.some((id) => agentId === id || agentId.startsWith(id) || id.startsWith(agentId));
}

/** 中核スレの閉じた行を「待機中」にする(`displayStatus`/`rowStatusText` が closed を「終了」にするため機械状態ごと写す)。 */
export function standbyForCoreClosed(
  rows: readonly ChildThread[],
  coreIds: readonly string[],
): ChildThread[] {
  return rows.map((t) => {
    if (t.machineState !== "closed") return t;
    if (!t.coordinator && !matchesAny(t.agentId, coreIds)) return t;
    return {
      ...t,
      machineState: "idle",
      status: t.status === "実装中" ? "待機中" : t.status,
    };
  });
}

/**
 * 中核スレ(完了箱Cなど)を、登録簿の親子・「実装中」に引きずられず上段に置く(2026-10-28 ユーザー報告
 * 「再起動後に完了箱Cが消えた」)。実際は消えたのでなく、完了報告係(c9d9ed6e)が建てた子スレ
 * (`child_threads.json` で親=「完了報告係の有効化」)として最下段の別グループに「実装中」で埋もれていた。
 * 旧 C(03aeafd)だけがピン止めされていて、新しい係はピン止めされていなかった。
 * - 親子を外して単独の行にし、ピン止め扱いにする(上段に出る。保存済みのピンファイルは書き換えない)。
 * - 待機が正常な常駐なので、動いていない(`idle`/`closed`)ときの「実装中」は「待機中」に直す。
 */
export function promoteCoreRows(
  rows: readonly ChildThread[],
  coreIds: readonly string[],
): ChildThread[] {
  return rows.map((t) => {
    if (t.coordinator || !matchesAny(t.agentId, coreIds)) return t;
    const standby =
      t.status === "実装中" && (t.machineState === "idle" || t.machineState === "closed");
    return {
      ...t,
      pinned: true,
      parentAgentId: null,
      parentTitle: null,
      status: standby ? "待機中" : t.status,
    };
  });
}

/**
 * 非表示 id と、本当に終わった `closed` の行を外す。ピン止め・見出しの親・中核は残す。
 * 非表示の親を持つ子は、親の見出し(`parentTitle`)ごと外して単独の行にする
 * (親の行だけ外しても、子の `parentTitle` から見出しが作られて残るため。2026-10-28 画面確認)。
 */
export function dropFinishedClosedRows(
  rows: readonly ChildThread[],
  coreIds: readonly string[],
  hiddenIds: readonly string[],
): ChildThread[] {
  return rows
    .filter((t) => {
      if (matchesAny(t.agentId, hiddenIds)) return false;
      if (t.machineState !== "closed") return true;
      if (t.coordinator || t.pinned || t.groupingParent) return true;
      if (matchesAny(t.agentId, coreIds)) return true;
      return !(t.status === "完了" || t.status === "待機中");
    })
    .map((t) =>
      t.parentAgentId && matchesAny(t.parentAgentId, hiddenIds)
        ? Object.assign({}, t, { parentAgentId: null, parentTitle: null })
        : t,
    );
}
