/**
 * サイドバーの「壁打ち」と「補助スレ」の振り分け(2026-10-30 ユーザー指示)。
 *
 * - 補助スレ: 裏方(司令塔)が建てて結果を回収する子スレ。登録簿(`child_threads.json`)に載る行、
 *   司令塔そのもの、子を持つ親(見出し)。サイドバーでは既定で折りたたむ。
 * - 壁打ち: ユーザーが直接話すスレ。登録簿に載らない(=人が自分で建てた)スレ、
 *   および自動で判定できないものはこちら(隠して見落とすより、出す側に倒す)。
 * - ユーザーが手で移した結果は `child_threads_sides.json` に保存し、自動判定より優先する(全端末共通)。
 *   司令塔の行は移せない(司令塔グループは補助スレの入れ子として常に補助側)。
 */
import fs from "node:fs";
import path from "node:path";
import { CHILD_THREAD_SIDES, CHILD_THREAD_SIDES_FILE } from "../shared/child-threads.js";
import type { ChildThread, ChildThreadSide } from "../shared/child-threads.js";
import { normalizeChildThreadOrder } from "./child-threads.js";

export type SideOverrides = ReadonlyMap<string, ChildThreadSide>;

const isSide = (v: unknown): v is ChildThreadSide =>
  (CHILD_THREAD_SIDES as readonly unknown[]).includes(v);

/** 手動の振り分けの読み込み(壊れた/無いファイルは空。一覧は止めない)。 */
export function readChildThreadSides(dir: string): Map<string, ChildThreadSide> {
  const out = new Map<string, ChildThreadSide>();
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, CHILD_THREAD_SIDES_FILE), "utf8"),
    );
    const sides = (raw as { sides?: unknown } | null)?.sides;
    if (sides && typeof sides === "object" && !Array.isArray(sides)) {
      for (const [id, side] of Object.entries(sides)) {
        const key = normalizeChildThreadOrder([id])[0];
        if (key && isSide(side)) out.set(key, side);
      }
    }
  } catch {
    // 読めない: 手動指定なし(自動判定のまま)
  }
  return out;
}

/** 1件だけ振り分けを変えて保存する(`side: null` は手動指定を外す)。保存は原子的に置換。 */
export function writeChildThreadSide(
  dir: string,
  agentId: string,
  side: ChildThreadSide | null,
): Map<string, ChildThreadSide> {
  const id = normalizeChildThreadOrder([agentId])[0];
  if (!id) throw new Error("agentId が空です");
  const next = readChildThreadSides(dir);
  // 壊れたファイルを黙って上書きしない(手動の振り分けを復元できるよう退避する)
  const existing = path.join(dir, CHILD_THREAD_SIDES_FILE);
  if (next.size === 0 && fs.existsSync(existing)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(existing, "utf8")) as { sides?: unknown } | null;
      const ok = parsed && typeof parsed === "object" && typeof parsed.sides === "object";
      if (!ok) fs.renameSync(existing, `${existing}.corrupt-${Date.now()}`);
    } catch {
      try {
        fs.renameSync(existing, `${existing}.corrupt-${Date.now()}`);
      } catch {
        // 退避できなくても保存は続ける
      }
    }
  }
  if (side === null) next.delete(id);
  else next.set(id, side);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, CHILD_THREAD_SIDES_FILE);
  const tmp = path.join(dir, `.${CHILD_THREAD_SIDES_FILE}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(
    { version: 1, updated_at: Date.now(), sides: Object.fromEntries(next) },
    null,
    2,
  );
  try {
    fs.writeFileSync(tmp, `${body}\n`, "utf8");
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 後始末の失敗で元のエラーを隠さない
    }
    throw error;
  }
  return next;
}

/**
 * 各行へ `aux`(補助スレ側か)を付ける。
 *
 * - 司令塔・子を持つ親(`groupingParent`)は常に補助側(移せない。見出しの入れ子を壊さない)。
 * - 手動指定があればそれ。無ければ「登録簿に載る行」=補助、載らない行=壁打ち。
 * - 壁打ちへ置く行は親の印を外す(司令塔・子司令塔の見出しの下へ吸われず、壁打ち側で平らに出る)。
 */
export function applyAuxGroup(
  threads: readonly ChildThread[],
  registeredIds: ReadonlySet<string>,
  overrides: SideOverrides,
): ChildThread[] {
  return threads.map((t) => {
    const fixedAux = t.coordinator === true || t.groupingParent === true;
    const manual = overrides.get(t.agentId);
    const aux = fixedAux || (manual ? manual === "aux" : registeredIds.has(t.agentId));
    if (aux) return t.aux ? t : { ...t, aux: true };
    const detached =
      t.parentAgentId === null && t.parentTitle === null
        ? t
        : { ...t, parentAgentId: null, parentTitle: null };
    return detached.aux ? { ...detached, aux: false } : detached;
  });
}
