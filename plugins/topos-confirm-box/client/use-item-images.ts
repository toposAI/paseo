/**
 * カードの添付画像を、カードが描画されたときに1枚ずつ取る(一覧の通信には画像本体を載せない)。
 * 取れるまでは uri が空のまま返る(部品は同じ大きさの枠だけを出す)。取れた分は覚えておき、再描画・再取得で取り直さない。
 */
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { confirmBoxImageRpc, type ConfirmBoxItem } from "../shared/contract.js";

const cache = new Map<string, string>();
/** 取得中の要求。同じ画像を複数の部品が同時に求めても1回で済ませる。 */
const inflight = new Map<string, Promise<boolean>>();
/** 覚えておく画像の上限(古い順に捨てる)。捨てた分は次に描画されたとき取り直す。 */
const CACHE_LIMIT = 80;

function remember(key: string, uri: string) {
  cache.delete(key);
  cache.set(key, uri);
  for (const old of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break;
    cache.delete(old);
  }
}

export function useItemImageSources(item: Pick<ConfirmBoxItem, "id" | "images">, enabled = true) {
  const fetchImage = useRpc(confirmBoxImageRpc);
  const count = item.images?.length ?? 0;
  const [version, bump] = useState(0);
  useEffect(() => {
    if (!enabled || count === 0) return undefined;
    let alive = true;
    for (let i = 0; i < count; i += 1) {
      const key = `${item.id}:${i}`;
      if (cache.has(key)) continue;
      let pending = inflight.get(key);
      if (!pending) {
        pending = fetchImage({ id: item.id, index: i })
          .then((r) => {
            if (!r.image) return false;
            remember(key, `data:${r.image.mimeType};base64,${r.image.data}`);
            return true;
          })
          .catch(() => false) // 取れなければ枠のまま(カードがもう一度出たとき取り直す)
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, pending);
      }
      void pending.then((ok) => {
        if (ok && alive) bump((n) => n + 1);
        return ok;
      });
    }
    return () => {
      alive = false;
    };
  }, [item.id, count, enabled, fetchImage]);
  return useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        key: `${item.id}:${i}`,
        uri: cache.get(`${item.id}:${i}`) ?? "",
      })),
    // bump の再描画ごとに作り直す(cache が変わったため)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id, count, version],
  );
}
