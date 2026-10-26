/**
 * 会話ペインの開閉をURL(`?card=<id>` / `?thread=<agent id>`)とブラウザ履歴に結びつける。
 *
 * - 一覧から開く: 履歴を1つ積む(pushState)。ブラウザ戻るで一覧に戻る。
 * - 開いたまま別の相手へ: 置き換える(replaceState)。「戻る」1回で一覧へ戻れるようにする。
 * - 閉じる: 自分が積んだ履歴なら back、URL復元で開いていたなら replace で card/thread を消す。
 *
 * 開ける相手は2種(カードの投函元スレ / 優先順位行の担当スレ)。どちらも同じペインに出すので、
 * 開くときは**両方のパラメータを明示**して片方を消す(`shared/card-pane.ts` の `searchWithPane`)。
 *
 * web 以外(ネイティブアプリ)ではURLが無いのでローカル状態だけになる。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { paneTargetFromSearch, searchWithPane } from "../shared/card-pane.js";
import type { PaneTarget } from "../shared/card-pane.js";

const isWeb = Platform.OS === "web";

function currentPane(): PaneTarget | null {
  if (!isWeb || typeof window === "undefined") return null;
  return paneTargetFromSearch(window.location.search);
}

const samePane = (a: PaneTarget | null, b: PaneTarget | null) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

/** `?card=` / `?thread=` を消す時の引数(両方渡して片方を確実に落とす)。 */
const NO_PANE = { card: null, thread: null };

export function useCardPaneRoute(enabled: boolean): {
  pane: PaneTarget | null;
  /** 開く。既に同じ相手が開いていれば畳む(💬 のトグル)。 */
  open: (target: PaneTarget) => void;
  close: () => void;
  /** 履歴を動かさずに外す(同じ相手を主ペインで開き直すとき。戻るで元に戻さない)。 */
  fold: () => void;
} {
  const [pane, setPane] = useState<PaneTarget | null>(() => (enabled ? currentPane() : null));
  // このセッションで push した履歴を持っているか(close で back するかの判定)。
  const pushed = useRef(false);
  // 現在ペインが開いているか(別の相手への移動を replace にするかの判定)。
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = pane !== null;
  }, [pane]);

  useEffect(() => {
    if (!enabled) {
      setPane(null);
      return undefined;
    }
    if (!isWeb || typeof window === "undefined") return undefined;
    setPane(currentPane());
    const onPop = () => {
      // 履歴移動後は「戻る」で閉じる対象を失う(URLが正)。
      pushed.current = false;
      setPane(currentPane());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [enabled]);

  // リサイズ・回転のたびに、状態とURLの**両方向**を突き合わせ直す。
  // - URLに相手が残っているのに状態だけ落ちた場合(状態保持の取りこぼし)は、状態をURLから戻す。
  // - 逆に状態は開いているのにURLから消えていたら、再読み込み・共有で戻せるよう貼り直す。
  // ホスト側のURL正規化(`stripHostWorkspaceRouteEchoSearch`)が消すのは serverId/workspaceId/pop
  // だけで card/thread は対象外なので、通常はどちらも起きない。ここは「起きてしまったとき」の
  // 突き合わせであって、ホストが落とす前提の処理ではない。
  useEffect(() => {
    if (!enabled || !pane || !isWeb || typeof window === "undefined") return undefined;
    const reassert = () => {
      const inUrl = currentPane();
      if (inUrl && !samePane(inUrl, pane)) {
        // URLが正: ブラウザ戻る/進むや外部からの遷移でURLだけが変わった場合に追従する。
        setPane(inUrl);
        return;
      }
      if (samePane(inUrl, pane)) return;
      const url = new URL(window.location.href);
      url.search = searchWithPane(url.search, {
        card: pane.kind === "card" ? pane.id : null,
        thread: pane.kind === "thread" ? pane.id : null,
      });
      window.history.replaceState(window.history.state, "", url.toString());
    };
    reassert();
    window.addEventListener("resize", reassert);
    return () => window.removeEventListener("resize", reassert);
  }, [pane, enabled]);

  /** ペインを外す(URLは自分が積んだ履歴なら1つ戻る)。 */
  const drop = useCallback(() => {
    setPane(null);
    openRef.current = false;
    if (!enabled || !isWeb || typeof window === "undefined") return;
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    const next = searchWithPane(url.search, NO_PANE);
    if (next === url.search) return;
    url.search = next;
    window.history.replaceState(window.history.state, "", url.toString());
  }, [enabled]);

  const open = useCallback(
    (target: PaneTarget) => {
      if (samePane(pane, target)) {
        drop();
        return;
      }
      const wasOpen = openRef.current;
      setPane(target);
      openRef.current = true;
      if (!enabled || !isWeb || typeof window === "undefined") return;
      const url = new URL(window.location.href);
      const next = searchWithPane(url.search, {
        card: target.kind === "card" ? target.id : null,
        thread: target.kind === "thread" ? target.id : null,
      });
      if (next === url.search) return;
      url.search = next;
      if (wasOpen) {
        window.history.replaceState(window.history.state, "", url.toString());
      } else {
        window.history.pushState(window.history.state, "", url.toString());
        pushed.current = true;
      }
    },
    [enabled, pane, drop],
  );

  /** 外すが履歴は動かさない(直後の遷移を「戻る」で巻き戻さないため)。 */
  const fold = useCallback(() => {
    setPane(null);
    openRef.current = false;
    pushed.current = false;
    if (!enabled || !isWeb || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const next = searchWithPane(url.search, NO_PANE);
    if (next === url.search) return;
    url.search = next;
    window.history.replaceState(window.history.state, "", url.toString());
  }, [enabled]);

  return { pane, open, close: drop, fold };
}
