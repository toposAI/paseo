import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_MIN_WIDTH,
  LIST_GRID_GAP,
  MAX_COLUMNS,
  listCellWidth,
  listColumns,
} from "../shared/list-grid.js";

test("iPhone幅(wide=false)は常に1列", () => {
  for (const w of [320, 390, 430, 1400]) {
    assert.equal(listColumns(w, false), 1, `width=${w}`);
    assert.equal(listCellWidth(w, 1), undefined);
  }
});

test("PC幅: 幅が広いほど列が増え、3列で頭打ち", () => {
  assert.equal(listColumns(1400, true), MAX_COLUMNS);
  assert.equal(listColumns(2000, true), MAX_COLUMNS);
});

test("PC幅: 幅が読めない・0以下は1列(潰れたカードを出さない)", () => {
  for (const w of [0, -100, Number.NaN]) {
    assert.equal(listColumns(w, true), 1, `width=${w}`);
  }
});

test("列が減ると2列以下になる(右ペインが開いて一覧が狭くなったとき)", () => {
  assert.equal(listColumns(CARD_MIN_WIDTH * 2 + LIST_GRID_GAP, true), 2);
  assert.equal(listColumns(CARD_MIN_WIDTH + LIST_GRID_GAP - 1, true), 1);
});

test("3列になるのは幅 1006px から(330*3 + 8*2)", () => {
  assert.equal(listColumns(1005, true), 2);
  assert.equal(listColumns(1006, true), 3);
});

test("1枚の幅: 列数ぶん+すき間が一覧幅に収まる(端数で折り返さない)", () => {
  // 実測幅は端数つきで来る(呼び出し側で Math.floor 済み)。切り上げで3枚目がはみ出さないこと。
  for (const total of [800, 975, 976, 998, 999, 1030, 1400, 2000]) {
    const cols = listColumns(total, true);
    const cell = listCellWidth(total, cols);
    assert.ok(cell !== undefined, `total=${total}`);
    assert.ok(cols * cell + LIST_GRID_GAP * (cols - 1) <= total, `total=${total}`);
    assert.ok(cell >= CARD_MIN_WIDTH, `total=${total} cell=${cell}`);
  }
});
