/**
 * カードの添付画像を、カードが描画されたときに1枚ずつ取る(一覧の通信には画像本体を載せない)。
 * 取れるまでは uri が空のまま返る(部品は同じ大きさの枠だけを出す)。取れた分は覚えておき、再描画・再取得で取り直さない。
 */
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { confirmBoxImageRpc, type ConfirmBoxItem } from "../shared/contract.js";

const cache = new Map<string, string>();

export function useItemImageSources(item: Pick<ConfirmBoxItem, "id" | "images">, enabled = true) {
  const fetchImage = useRpc(confirmBoxImageRpc);
  const count = item.images?.length ?? 0;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || count === 0) return undefined;
    let alive = true;
    for (let i = 0; i < count; i += 1) {
      const key = `${item.id}:${i}`;
      if (cache.has(key)) continue;
      void fetchImage({ id: item.id, index: i })
        .then((r) => {
          if (!r.image) return false;
          cache.set(key, `data:${r.image.mimeType};base64,${r.image.data}`);
          if (alive) bump((n) => n + 1);
          return true;
        })
        .catch(() => false); // 取れなければ枠のまま(次に描画されたとき取り直す)
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
    [item.id, count, cache.size],
  );
}
