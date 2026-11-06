import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readFeedbackScreenshot } from "./feedback-screenshot.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbshot-"));
  fs.mkdirSync(path.join(dir, "screenshots"));
  return dir;
}

test("正常系: data URI を返す", () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, "screenshots", "a.png"), Buffer.from([1, 2, 3]));
  const r = readFeedbackScreenshot("a.png", ["/nonexistent", dir]);
  assert.equal(r.ok, true);
  assert.equal(r.dataUri, `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
});

test("パストラバーサルは拒否", () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, "x.png"), "x");
  assert.equal(readFeedbackScreenshot("../x.png", [dir]).ok, false);
  assert.equal(readFeedbackScreenshot("..", [dir]).ok, false);
  assert.equal(readFeedbackScreenshot("", [dir]).ok, false);
});

test("拡張子違いは拒否", () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, "screenshots", "a.txt"), "x");
  assert.equal(readFeedbackScreenshot("a.txt", [dir]).ok, false);
});

test("無いファイルは拒否", () => {
  const dir = setup();
  assert.equal(readFeedbackScreenshot("none.png", [dir]).ok, false);
});

test("シンボリックリンクでの脱出は拒否", () => {
  const dir = setup();
  const outside = path.join(dir, "secret.png");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(dir, "screenshots", "link.png"));
  assert.equal(readFeedbackScreenshot("link.png", [dir]).ok, false);
});
