/**
 * サイドバー下部のタブ(スレ一覧 / 構想一覧)の**現在値**。
 *
 * タブはホストのサイドバー下部バー(`addSidebarFooterItem`)の2項目で、押すとここの値を変える。
 * サイドバー本体(`ChildThreadsSidebar`)は `useSidebarMode()` で同じ値を見る。両者は別の
 * コンポーネントとして描かれるので、props ではなく**モジュール束縛の小さなストア**で繋ぐ。
 *
 * 値の検証・保存の失敗時の扱いは `shared/sidebar-section-mode.ts` の純粋関数が正
 * (`server/sidebar-section-mode.test.ts` で単体テスト済み)。ここはその薄い配線だけ。
 */
import { useSyncExternalStore } from "react";
import {
  DEFAULT_SIDEBAR_SECTION,
  type SidebarSectionKey,
  loadStoredSection,
  saveStoredSection,
  sectionAfterPress,
} from "../shared/sidebar-section-mode.js";

let current: SidebarSectionKey | null = null;
const listeners = new Set<() => void>();

/** ブラウザの保存領域(無い環境=SSR・ネイティブの一部では undefined)。 */
function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // アクセス自体が投げる環境(サンドボックス化された iframe など)。
    return undefined;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 現在のタブ。未設定なら保存値(無ければスレ一覧)から一度だけ読む。 */
export function getSidebarMode(): SidebarSectionKey {
  current ??= loadStoredSection(storage());
  return current;
}

/**
 * タブを押した: そのタブの一覧へ切り替え、保存する(保存できなくても切替は効く)。
 * 同じタブを押し直しても入れ替えない(`sectionAfterPress`)。
 */
export function setSidebarMode(pressed: SidebarSectionKey): SidebarSectionKey {
  const next = sectionAfterPress(getSidebarMode(), pressed);
  if (next === current) return next;
  current = next;
  saveStoredSection(storage(), next);
  for (const listener of listeners) listener();
  return next;
}

/** テスト用: 保存値から読み直す(本番の描画経路では呼ばない)。 */
export function resetSidebarModeForTest(): void {
  current = null;
  for (const listener of listeners) listener();
}

/** サイドバー本体とタブが購読する。 */
export function useSidebarMode(): SidebarSectionKey {
  return useSyncExternalStore(subscribe, getSidebarMode, () => DEFAULT_SIDEBAR_SECTION);
}
