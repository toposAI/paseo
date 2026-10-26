import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPosition, READ_POSITIONS_FILE, setEnabled, setPosition } from "./read-position.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "readpos-"));

test("題名に完了箱Cを含むスレだけ既定で記録する", () => {
  const d = tmp();
  assert.equal(getPosition(d, "a", "完了箱C").enabled, true);
  assert.equal(getPosition(d, "a", "別のスレ").enabled, false);
  assert.equal(getPosition(d, "a").enabled, false);
});

test("常駐の窓口スレ(判断窓口A/A'・窓口B)も既定で記録する", () => {
  const d = tmp();
  assert.equal(getPosition(d, "a", "判断窓口A").enabled, true);
  assert.equal(getPosition(d, "a", "判断窓口A'").enabled, true);
  assert.equal(getPosition(d, "a", "窓口B").enabled, true);
  // 読み手自身が入力する通常のスレは対象外。
  assert.equal(getPosition(d, "a", "窓口の話").enabled, false);
});

test("対象外のスレには書かない", () => {
  const d = tmp();
  assert.deepEqual(setPosition(d, "a", "別のスレ", 5, "e1"), {
    ok: true,
    seq: null,
  });
  assert.equal(fs.existsSync(path.join(d, READ_POSITIONS_FILE)), false);
});

test("同じ世代では進む方向だけ採る", () => {
  const d = tmp();
  assert.equal(setPosition(d, "a", "完了箱C", 10, "e1").seq, 10);
  assert.equal(setPosition(d, "a", "完了箱C", 4, "e1").seq, 10);
  assert.equal(setPosition(d, "a", "完了箱C", 12, "e1").seq, 12);
  assert.equal(getPosition(d, "a", "完了箱C").seq, 12);
});

test("世代が変われば新しい方で置き換える", () => {
  const d = tmp();
  setPosition(d, "a", "完了箱C", 10, "e1");
  assert.equal(setPosition(d, "a", "完了箱C", 2, "e2").seq, 2);
  assert.equal(getPosition(d, "a", "完了箱C").epoch, "e2");
});

test("設定の上書きが既定に勝ち、nullで既定に戻る", () => {
  const d = tmp();
  setEnabled(d, "a", true);
  assert.equal(getPosition(d, "a", "別のスレ").enabled, true);
  setEnabled(d, "a", false);
  assert.equal(getPosition(d, "a", "完了箱C").enabled, false);
  setEnabled(d, "a", null);
  assert.equal(getPosition(d, "a", "完了箱C").enabled, true);
});

test("壊れたファイルは空として扱い、次の保存で作り直す", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, READ_POSITIONS_FILE), "{broken");
  assert.equal(getPosition(d, "a", "完了箱C").seq, null);
  assert.equal(setPosition(d, "a", "完了箱C", 3, "e1").seq, 3);
});

test("一度記録した完了箱Cは、題名が変わっても記録が続く", () => {
  const d = tmp();
  setPosition(d, "a", "完了箱C", 5, "e1");
  assert.equal(getPosition(d, "a", "名前を変えた").enabled, true);
  assert.equal(setPosition(d, "a", undefined, 9, "e1").seq, 9);
});
