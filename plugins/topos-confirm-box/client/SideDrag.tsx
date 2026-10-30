/**
 * 壁打ち⇔補助スレのドラッグ移動(PC=Web 幅だけ。2026-10-30 ユーザー指示)。
 *
 * ホストの並べ替え部品は1つの一覧の中の並べ替え専用で、群をまたげない。そこで行の左の「つかみ」だけを
 * ブラウザ標準のドラッグ(HTML5)にし、2群の見出しと中身をドロップ先にする。行そのもののドラッグ
 * (同じ群の中の並べ替え)には触らない。保存はメニュー移動と同じ(`onToggleSide`)。
 * スマホ幅・ネイティブでは何も描かない(メニューで移す)。
 */
import React, { useCallback, useState } from "react";
import { Platform } from "react-native";

import type { ChildThread } from "../shared/child-threads.js";
import type { SidebarSide } from "../shared/sidebar-rows.js";
import { sideMenuLabel } from "../shared/thread-menu.js";

export const SIDE_DRAG_ENABLED = Platform.OS === "web";

/** この行をドラッグで移せるか(司令塔・見出しの親は移せない)。 */
export const canDragBetweenSides = (t: ChildThread): boolean => sideMenuLabel(t) !== null;

const sideOfDragged = (t: ChildThread): SidebarSide => (t.aux ? "aux" : "walltalk");

/**
 * 行を包んで、左端に「つかみ」を重ねる(行末は状態の帯ひとつだけ、という決まりがあるので行末には置かない)。
 * これを持ってドロップ先の見出しへ運ぶ。移せない行・スマホ幅ではそのまま子を返す。
 */
export function SideDragRow({
  thread,
  onStart,
  onEnd,
  color,
  children,
}: {
  thread: ChildThread;
  onStart: (t: ChildThread) => void;
  onEnd: () => void;
  color: string;
  children: React.ReactElement;
}) {
  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData("text/plain", thread.agentId);
      e.dataTransfer.effectAllowed = "move";
      onStart(thread);
    },
    [onStart, thread],
  );
  if (!SIDE_DRAG_ENABLED || !canDragBetweenSides(thread)) return children;
  const to = sideOfDragged(thread) === "aux" ? "壁打ち" : "補助スレ";
  const grip = React.createElement(
    "span",
    {
      draggable: true,
      onDragStart,
      onDragEnd: onEnd,
      title: `ドラッグして${to}へ移す`,
      "aria-label": `${to}へドラッグして移す`,
      "data-testid": `child-thread-grip-${thread.agentId}`,
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        cursor: "grab",
        color,
        opacity: 0.6,
        fontSize: 11,
        padding: "0 2px",
        userSelect: "none",
        zIndex: 1,
      },
    },
    "⠿",
  );
  return React.createElement("div", { style: { position: "relative" } }, grip, children);
}

/** 2群のそれぞれを包むドロップ先。違う側の行を運んでいる間だけ反応し、枠で示す。 */
export function SideDropZone({
  side,
  dragThread,
  onDropSide,
  accent,
  children,
}: {
  side: SidebarSide;
  dragThread: ChildThread | null;
  onDropSide: (thread: ChildThread, side: SidebarSide) => void;
  accent: string;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const accepts = dragThread !== null && sideOfDragged(dragThread) !== side;
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!accepts) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    [accepts],
  );
  const onDragLeave = useCallback((e: React.DragEvent) => {
    // 子要素へ移っただけのときは枠を消さない
    if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setOver(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      setOver(false);
      if (!accepts || !dragThread) return;
      e.preventDefault();
      onDropSide(dragThread, side);
    },
    [accepts, dragThread, onDropSide, side],
  );
  if (!SIDE_DRAG_ENABLED) return children as React.ReactElement;
  return React.createElement(
    "div",
    {
      onDragOver,
      onDragLeave,
      onDrop,
      "data-testid": `child-side-drop-${side}`,
      style: {
        borderRadius: 8,
        outline: accepts ? `2px dashed ${accent}` : "none",
        outlineOffset: -2,
        background: over ? `${accent}22` : "transparent",
      },
    },
    children,
  );
}
