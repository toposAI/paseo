/**
 * 「完了」「却下」を押してから台帳へ書くまでの猶予(元に戻す用)。小さな状態機械で、
 * タイマーを差し替えられるので画面なしで試験できる。
 *
 * 押した瞬間はカードを「元に戻す」行へ置き換えるだけで、台帳へは書かない。猶予が切れたら commit を呼ぶ。
 * 猶予中に戻せば何も書かれない。画面を離れるとき(flushAll)は戻せなくなるので、その場で書く。
 */
export const UNDO_MS = 6000;

export interface CloserTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_TIMERS: CloserTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface DeferredCloser<T> {
  /** 猶予つきで閉じる。同じ id を二重に積まない(2回目は無視)。 */
  schedule: (id: string, payload: T) => boolean;
  /** 猶予中なら取り消して true。もう書いた/積んでいなければ false。 */
  undo: (id: string) => boolean;
  /** 猶予を待たずに全部書く(画面を離れるとき)。 */
  flushAll: () => void;
  has: (id: string) => boolean;
  /** いま猶予中の id(画面が「元に戻す」行を出す相手)。 */
  ids: () => string[];
}

export function createDeferredCloser<T>(
  commit: (id: string, payload: T) => void,
  onChange: () => void,
  ms: number = UNDO_MS,
  timers: CloserTimers = REAL_TIMERS,
): DeferredCloser<T> {
  const waiting = new Map<string, { payload: T; handle: unknown }>();
  const fire = (id: string) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    onChange();
    commit(id, w.payload);
  };
  return {
    schedule(id, payload) {
      if (waiting.has(id)) return false;
      waiting.set(id, { payload, handle: timers.set(() => fire(id), ms) });
      onChange();
      return true;
    },
    undo(id) {
      const w = waiting.get(id);
      if (!w) return false;
      timers.clear(w.handle);
      waiting.delete(id);
      onChange();
      return true;
    },
    flushAll() {
      for (const [id, w] of Array.from(waiting)) {
        timers.clear(w.handle);
        fire(id);
      }
    },
    has: (id) => waiting.has(id),
    ids: () => Array.from(waiting.keys()),
  };
}

/** 閉じる種類。どちらもコメントは要らず、台帳には決まった理由文が付く。 */
export type CloseKind = "done" | "reject";
export const DONE_REASON = "完了";
export const REJECT_NO_COMMENT_REASON = "却下(コメントなし)";
