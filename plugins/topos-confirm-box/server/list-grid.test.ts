import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_MIN_WIDTH,
  LIST_MAX_WIDTH,
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

test("PC幅でも常に1列(2026-11-07 ユーザー決定)", () => {
  assert.equal(MAX_COLUMNS, 1);
  for (const w of [720, 1006, 1400, 2000]) {
    assert.equal(listColumns(w, true), 1, `width=${w}`);
    assert.equal(listCellWidth(w, 1), undefined);
  }
});

test("1列のカード幅に上限がある", () => {
  assert.ok(LIST_MAX_WIDTH >= CARD_MIN_WIDTH && LIST_MAX_WIDTH <= 900);
});

test("PC幅: 幅が読めない・0以下は1列(潰れたカードを出さない)", () => {
  for (const w of [0, -100, Number.NaN]) {
    assert.equal(listColumns(w, true), 1, `width=${w}`);
  }
});
