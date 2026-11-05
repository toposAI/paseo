import assert from "node:assert/strict";
import test from "node:test";
import { composerHeight } from "../shared/composer-height.js";

test("空は最小高44", () => {
  assert.equal(composerHeight("", 300), 44);
});

test("2行は58", () => {
  assert.equal(composerHeight("a\nb", 300), 58);
});

test("15行は上限120", () => {
  assert.equal(composerHeight(Array(15).fill("x").join("\n"), 300), 120);
});

test("長い1行は折り返して増える", () => {
  const short = composerHeight("x".repeat(10), 160);
  const long = composerHeight("x".repeat(100), 160);
  assert.ok(long > short);
});
