import assert from "node:assert/strict";
import { test } from "node:test";
import { neighborIndex } from "../shared/image-nav.js";

test("neighborIndex: 端で反対側へ回る", () => {
  assert.equal(neighborIndex(0, 3, -1), 2);
  assert.equal(neighborIndex(2, 3, 1), 0);
  assert.equal(neighborIndex(1, 3, 1), 2);
});

test("neighborIndex: 0枚・1枚でも壊れない", () => {
  assert.equal(neighborIndex(0, 0, 1), 0);
  assert.equal(neighborIndex(0, 1, 1), 0);
});
