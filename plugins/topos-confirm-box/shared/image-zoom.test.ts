import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyWheel,
  clampTransform,
  IDENTITY,
  MAX_SCALE,
  toggleZoomAt,
  zoomAt,
} from "./image-zoom.js";

test("等倍では移動できず中央に戻る", () => {
  assert.deepEqual(clampTransform({ scale: 1, x: 50, y: -30 }, 400, 800), IDENTITY);
});

test("拡大率は上限と下限に収まる", () => {
  assert.equal(clampTransform({ scale: 99, x: 0, y: 0 }, 400, 800).scale, MAX_SCALE);
  assert.equal(clampTransform({ scale: 0.2, x: 0, y: 0 }, 400, 800).scale, 1);
});

test("拡大中は端に余白を出さない", () => {
  const t = clampTransform({ scale: 2, x: 100, y: -9999 }, 400, 800);
  assert.equal(t.x, 0);
  assert.equal(t.y, -800);
});

test("zoomAt は指定した点を動かさない", () => {
  const t = zoomAt(IDENTITY, 2, 300, 600, 400, 800);
  // 画像上の点 (300,600) は画面の (300,600) のまま
  assert.equal(300 * 2 + t.x, 300);
  assert.equal(600 * 2 + t.y, 600);
});

test("ダブルタップで拡大し、もう一度で戻る", () => {
  const zoomed = toggleZoomAt(IDENTITY, 200, 400, 400, 800);
  assert.equal(zoomed.scale, 3);
  assert.deepEqual(toggleZoomAt(zoomed, 200, 400, 400, 800), IDENTITY);
});

test("ctrlKey 付き wheel(トラックパッドのピンチ)で拡大し、逆向きで縮小する", () => {
  const zoomed = applyWheel(
    IDENTITY,
    { ctrlKey: true, deltaX: 0, deltaY: -20 },
    200,
    400,
    400,
    800,
  );
  assert.ok(zoomed.scale > 1);
  const back = applyWheel(zoomed, { ctrlKey: true, deltaX: 0, deltaY: 200 }, 200, 400, 400, 800);
  assert.ok(back.scale < zoomed.scale);
});

test("ctrlKey なし wheel は拡大中だけ画像を動かし、等倍では何もしない", () => {
  assert.deepEqual(
    applyWheel(IDENTITY, { ctrlKey: false, deltaX: 10, deltaY: 30 }, 0, 0, 400, 800),
    IDENTITY,
  );
  const z = zoomAt(IDENTITY, 3, 200, 400, 400, 800);
  const moved = applyWheel(z, { ctrlKey: false, deltaX: 20, deltaY: 40 }, 0, 0, 400, 800);
  assert.equal(moved.scale, 3);
  assert.equal(moved.x, z.x - 20);
  assert.equal(moved.y, z.y - 40);
});
