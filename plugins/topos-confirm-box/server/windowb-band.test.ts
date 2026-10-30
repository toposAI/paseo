import assert from "node:assert/strict";
import test from "node:test";
import { bandText } from "../shared/windowb-band.js";

// 2026-10-30 ユーザー指示「窓口Bの会話の上に細い帯『指示 N件・赤1』」
test("取得できていないときは帯を出さない(null)", () => {
  assert.equal(bandText(null), null);
});

test("赤があれば「指示 N件・赤M」、無ければ「指示 N件」", () => {
  assert.equal(bandText({ total: 12, alerts: 1 }), "指示 12件・赤1");
  assert.equal(bandText({ total: 0, alerts: 0 }), "指示 0件");
});
