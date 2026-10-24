/**
 * 箱の書き手(Python の notify_box / child_thread_registry)が、投函・取り下げ・再投函の直後に書く合図
 * (`<box>/box.signal.jsonl`・`<box>/child_threads.signal.jsonl`)。
 *
 * 30秒の定期取得だけだと、他スレの完了報告が確認箱のカード・下部バーのバッジに出るまで最大30秒かかる
 * (2026-10-24 ユーザー指摘「追加依頼した瞬間にカードが消えてほしい」)。ブラウザからは箱のディレクトリを
 * 読めないので RPC で合図の時刻だけを取り、中身は既存の RPC で取り直す。
 * 合図が無い(古い書き手)・読めない時は null を返し、定期取得に任せる(fail-open)。
 */
export type SignalName = "box" | "child_threads";

export type SignalTimes = Record<SignalName, number>;

/** 合図の時刻を返す関数(サーバの RPC で作る)。 */
export type GetSignalTimes = () => Promise<SignalTimes>;

/** 合図の更新時刻(box=確認箱の項目、child_threads=子スレの登録簿)。読めなければ null。 */
export async function fetchSignalTimes(get: GetSignalTimes): Promise<SignalTimes | null> {
  try {
    const v = await get();
    return { box: Number(v?.box) || 0, child_threads: Number(v?.child_threads) || 0 };
  } catch {
    return null;
  }
}

/**
 * 合図の時刻が進んだら `onChange` を呼ぶ(`which` は進んだ側)。5秒ごとに時刻だけを見る。
 * 時刻はファイルの mtime(ms)なので、前回より大きくなった時だけ拾う。
 * 同じ窓(既定1秒)に複数の合図が来たら最後の1回だけ呼ぶ(夜間の一括投函で重い一覧を取り直し続けない。
 * round6指摘6)。
 */
export function watchBoxSignal(
  get: GetSignalTimes,
  onChange: (which: SignalName) => void,
  intervalMs = 5_000,
  coalesceMs = 1_000,
): () => void {
  let alive = true;
  let last: SignalTimes | null = null;
  const pending = new Set<SignalName>();
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const fire = (name: SignalName) => {
    pending.add(name);
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!alive) return;
      // 両方来たら子スレ完了(重い側)だけを1回呼ぶ
      const which = pending.has("child_threads") ? "child_threads" : "box";
      pending.clear();
      onChange(which);
    }, coalesceMs);
  };
  const check = async () => {
    const s = await fetchSignalTimes(get);
    if (!alive || !s) return;
    if (last) {
      for (const name of ["box", "child_threads"] as const) {
        if (s[name] > last[name]) fire(name);
      }
    }
    last = s;
  };
  void check();
  const timer = setInterval(() => void check(), intervalMs);
  return () => {
    alive = false;
    clearInterval(timer);
    if (pendingTimer) clearTimeout(pendingTimer);
  };
}
