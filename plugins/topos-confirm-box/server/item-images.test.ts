import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readItemImage } from "./item-images.js";

function post(dir: string, id: string, data: string) {
  const row = {
    t: "item",
    ts: Date.now(),
    id,
    subject: "s",
    images: [{ data, mimeType: "image/png" }],
  };
  fs.appendFileSync(path.join(dir, "events-202611.jsonl"), `${JSON.stringify(row)}\n`);
}

test("画像を id と番号で引け、存在しない id・範囲外は null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "item-img-"));
  post(dir, "a1", "AAAA");
  const got = readItemImage(dir, "a1", 0);
  assert.equal(got?.data, "AAAA");
  assert.equal(readItemImage(dir, "nope", 0), null);
  assert.equal(readItemImage(dir, "a1", 3), null);
});

test("台帳が更新されたら索引を作り直す", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "item-img-"));
  assert.equal(readItemImage(dir, "b1", 0), null);
  post(dir, "b1", "BBBB");
  const got = readItemImage(dir, "b1", 0);
  assert.equal(got?.data, "BBBB");
});
