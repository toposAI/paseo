/** 右チャットペインの幅(左端の境界をドラッグで変更・保存、ダブルクリック/ダブルタップで既定へ)。 */
import { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder } from "react-native";
import {
  PANE_WIDTH_KEY,
  clampPaneWidth,
  defaultPaneWidth,
  parseStoredPaneWidth,
} from "../shared/pane-width.js";

export function usePaneResize(width: number) {
  const totalRef = useRef(width);
  totalRef.current = width;
  // PC幅の右ペイン幅。左端の境界をドラッグして変え、保存する(ダブルクリック/ダブルタップで既定へ)。
  const [userWidth, setUserWidth] = useState<number | null>(() => {
    try {
      return parseStoredPaneWidth(globalThis.localStorage?.getItem(PANE_WIDTH_KEY));
    } catch {
      return null;
    }
  });
  const paneWidth = useMemo(
    () => (userWidth === null ? defaultPaneWidth(width) : clampPaneWidth(userWidth, width)),
    [userWidth, width],
  );
  const paneWidthRef = useRef(paneWidth);
  paneWidthRef.current = paneWidth;
  const saveWidth = useCallback((value: number | null) => {
    try {
      if (value === null) globalThis.localStorage?.removeItem(PANE_WIDTH_KEY);
      else globalThis.localStorage?.setItem(PANE_WIDTH_KEY, String(value));
    } catch {
      // 保存できなくても幅は今の画面では効く。
    }
  }, []);
  const resizeStart = useRef(0);
  const lastTap = useRef(0);
  const resizePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          resizeStart.current = paneWidthRef.current;
        },
        // ペインは右にあるので、左へ動かすほど広がる。
        onPanResponderMove: (_e, g) =>
          setUserWidth(clampPaneWidth(resizeStart.current - g.dx, totalRef.current)),
        onPanResponderRelease: (_e, g) => {
          if (Math.abs(g.dx) < 3) {
            // 動いていない=タップ。400ms以内の2回目で既定幅へ戻す。
            const now = Date.now();
            if (now - lastTap.current < 400) {
              setUserWidth(null);
              saveWidth(null);
              lastTap.current = 0;
            } else {
              lastTap.current = now;
            }
            return;
          }
          saveWidth(clampPaneWidth(resizeStart.current - g.dx, totalRef.current));
        },
      }),
    [saveWidth],
  );
  return { paneWidth, resizeHandlers: resizePan.panHandlers };
}
