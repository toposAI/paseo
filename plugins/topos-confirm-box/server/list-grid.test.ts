import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_MIN_WIDTH,
  LIST_GRID_GAP,
  LIST_GRID_PADDING,
  MAX_COLUMNS,
  listCellWidth,
  listColumns,
} from "../shared/list-grid.js";

const usable = (w: number) => w - LIST_GRID_PADDING * 2;

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
  // 一覧がカード2枚ぶんちょうどに近い幅なら2列、1枚ぶんに満たなければ1列。
  assert.equal(listColumns(CARD_MIN_WIDTH * 2 + LIST_GRID_GAP + LIST_GRID_PADDING * 2, true), 2);
  assert.equal(listColumns(CARD_MIN_WIDTH + LIST_GRID_PADDING * 2 - 1, true), 1);
});

test("1枚の幅: 列数ぶん+すき間が一覧幅に収まる", () => {
  for (const total of [800, 1030, 1400, 2000]) {
    const cols = listColumns(total, true);
    const cell = listCellWidth(total, cols);
    assert.ok(cell !== undefined);
    assert.ok(cols * cell + LIST_GRID_GAP * (cols - 1) <= usable(total), `total=${total}`);
    assert.ok(cell >= Math.min(CARD_MIN_WIDTH, Math.floor(usable(total) / cols)));
  }
});
