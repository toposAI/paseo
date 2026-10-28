/**
 * プラグインの画面を開く入口(クライアント側)。
 *
 * 画面を開くのは `contribute` が受け取った `ctx.openScreen` だけなので、`contribute` のときに
 * ここへ1つ預けてもらい、部品(面板・行)からはこの関数を通して開く。`index.client.tsx` と
 * 部品の循環 import を避けるための小さな受け口。
 */
import { BOX_TAB_SCREEN_ID } from "../shared/footer-tabs.js";

interface ScreenInput {
  screenId: string;
  params?: Record<string, string>;
}
type ScreenOpener = (input: ScreenInput) => void;

let opener: ScreenOpener | null = null;

export function setScreenOpener(fn: ScreenOpener | null): void {
  opener = fn;
}

/** 確認箱の「優先順位」タブを開く(台帳の行の開発プロジェクトから)。 */
export function openPriorityScreen(): void {
  opener?.({ screenId: BOX_TAB_SCREEN_ID, params: { tab: "priority" } });
}
