/**
 * 全画面で見る画像の拡大部品(Web)。ピンチ・ダブルタップ・ホイール・ドラッグで拡大して動かせる。
 * 元の解像度の画像(data URI)を <img> のまま出し、transform で拡大する(縮小版に差し替えない)。
 * touch-action:none でブラウザ標準のページ拡大・スクロールとの取り合いを避け、操作はすべてここで受ける。
 * ネイティブ(Web 以外)は拡大せず、従来どおり画面に収めて出す。
 */
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Image, Platform } from "react-native";
import {
  clampTransform,
  IDENTITY,
  applyWheel,
  toggleZoomAt,
  zoomAt,
  type ZoomTransform,
} from "../shared/image-zoom.js";

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 30;
const TAP_SLOP = 8;

const FRAME_STYLE: React.CSSProperties = {
  flex: 1,
  alignSelf: "stretch",
  position: "relative",
  overflow: "hidden",
  touchAction: "none",
  userSelect: "none",
  WebkitUserSelect: "none",
  cursor: "zoom-in",
};
const IMG_STYLE: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: "100%",
  height: "100%",
  objectFit: "contain",
  transformOrigin: "0 0",
  willChange: "transform",
  pointerEvents: "none",
  userSelect: "none",
  WebkitUserSelect: "none",
};
const NATIVE_STYLE = { flex: 1, alignSelf: "stretch" as const };

interface Pt {
  x: number;
  y: number;
}

export function ZoomableImage({ uri, label }: { uri: string; label: string }) {
  const source = useMemo(() => ({ uri }), [uri]);
  if (Platform.OS !== "web") {
    return (
      <Image accessibilityLabel={label} source={source} style={NATIVE_STYLE} resizeMode="contain" />
    );
  }
  return <WebZoomableImage uri={uri} label={label} />;
}

function WebZoomableImage({ uri, label }: { uri: string; label: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const tf = useRef<ZoomTransform>(IDENTITY);
  const pointers = useRef(new Map<number, Pt>());
  const pinch = useRef<{ dist: number; tf: ZoomTransform; mid: Pt } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const moved = useRef(0);

  const apply = useCallback((next: ZoomTransform) => {
    tf.current = next;
    const img = imgRef.current;
    if (img) img.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    const frame = frameRef.current;
    if (frame) frame.style.cursor = next.scale > 1 ? "grab" : "zoom-in";
  }, []);

  const size = useCallback(() => {
    const r = frameRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1, left: r?.left ?? 0, top: r?.top ?? 0 };
  }, []);

  // 画像が変わったら等倍に戻す(前後ボタンで別画像へ移ったとき)。
  useEffect(() => {
    apply(IDENTITY);
    pointers.current.clear();
    pinch.current = null;
    lastTap.current = null;
  }, [uri, apply]);

  // wheel は preventDefault したいので passive:false で自前に付ける(React の onWheel は passive)。
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { w, h, left, top } = size();
      apply(applyWheel(tf.current, e, e.clientX - left, e.clientY - top, w, h));
    };
    // Safari のトラックパッドのピンチは wheel でなく gesture イベントで届く(ページ拡大を止めて自前で拡大)。
    let gestureBase: ZoomTransform | null = null;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureBase = tf.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      if (!gestureBase || g.scale === undefined) return;
      const { w, h, left, top } = size();
      const px = (g.clientX ?? left + w / 2) - left;
      const py = (g.clientY ?? top + h / 2) - top;
      apply(zoomAt(gestureBase, gestureBase.scale * g.scale, px, py, w, h));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureBase = null;
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    frame.addEventListener("gesturestart", onGestureStart);
    frame.addEventListener("gesturechange", onGestureChange);
    frame.addEventListener("gestureend", onGestureEnd);
    return () => {
      frame.removeEventListener("wheel", onWheel);
      frame.removeEventListener("gesturestart", onGestureStart);
      frame.removeEventListener("gesturechange", onGestureChange);
      frame.removeEventListener("gestureend", onGestureEnd);
    };
  }, [apply, size]);

  const startPinch = useCallback(() => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const { left, top } = size();
    pinch.current = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      tf: tf.current,
      mid: { x: (a.x + b.x) / 2 - left, y: (a.y + b.y) / 2 - top },
    };
  }, [size]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      frameRef.current?.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 1) moved.current = 0;
      if (pointers.current.size === 2) startPinch();
    },
    [startPinch],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pointers.current.set(e.pointerId, cur);
      const { w, h, left, top } = size();
      const base = pinch.current;
      if (pointers.current.size >= 2 && base) {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2 - left, y: (a.y + b.y) / 2 - top };
        // 開始時の中点を基準に拡大し、指の中点が動いたぶんだけ平行移動する。
        const z = zoomAt(base.tf, base.tf.scale * (dist / base.dist), base.mid.x, base.mid.y, w, h);
        apply(
          clampTransform(
            { scale: z.scale, x: z.x + (mid.x - base.mid.x), y: z.y + (mid.y - base.mid.y) },
            w,
            h,
          ),
        );
        moved.current = TAP_SLOP + 1;
        return;
      }
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      moved.current += Math.abs(dx) + Math.abs(dy);
      if (tf.current.scale > 1) {
        apply(clampTransform({ ...tf.current, x: tf.current.x + dx, y: tf.current.y + dy }, w, h));
      }
    },
    [apply, size],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.delete(e.pointerId)) return;
      pinch.current = null;
      // 2本指の片方を離したら、残りの指でドラッグを続ける(拡大率は保つ)。
      if (pointers.current.size > 0 || moved.current > TAP_SLOP) {
        moved.current = TAP_SLOP + 1;
        lastTap.current = null;
        return;
      }
      // 動かさずに離した=タップ。続けて近くをもう一度押したらダブルタップ(マウスのダブルクリックも同じ)。
      const now = Date.now();
      const prev = lastTap.current;
      const near =
        prev !== null && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_DIST;
      if (prev && near && now - prev.t < DOUBLE_TAP_MS) {
        const { w, h, left, top } = size();
        apply(toggleZoomAt(tf.current, e.clientX - left, e.clientY - top, w, h));
        lastTap.current = null;
      } else {
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
    },
    [apply, size],
  );

  return React.createElement(
    "div",
    {
      ref: frameRef,
      "data-testid": "zoomable-image",
      style: FRAME_STYLE,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
    React.createElement("img", {
      ref: imgRef,
      src: uri,
      alt: label,
      draggable: false,
      style: IMG_STYLE,
    }),
  );
}
