/**
 * 確認箱の項目に添える画像(案C)の読み取りの回帰テスト。
 *
 * 投函側が `images: [{ data, mimeType }]` を付けたとき、箱の行(events-*.jsonl)と
 * 中間形式(pending_user_decisions.jsonl)のどちらからもカードまで届くこと、
 * 上限(4枚・1枚2MiB)と不正な要素は**項目ごと捨てずに画像だけ落とす**ことを固定する。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { foldBoxEvents, parsePendingRecords } from "./box.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function image(data = PNG, mimeType = "image/png") {
  return { data, mimeType };
}

function boxItem(images: unknown) {
  const items = foldBoxEvents([{ t: "item", id: "box:img", ts: 1, images }]);
  return items.get("box:img");
}

test("画像2枚つきの項目はそのまま残る", () => {
  const item = boxItem([image(PNG, "image/png"), image("AAAA", "image/jpeg")]);
  assert.ok(item);
  assert.equal(item.id, "box:img"); // 画像の有無に関わらず項目自体は普通に読める
  assert.deepEqual(item.images, [
    { data: PNG, mimeType: "image/png" },
    { data: "AAAA", mimeType: "image/jpeg" },
  ]);
});

test("5枚以上あっても4枚で頭打ちにする", () => {
  const six = Array.from({ length: 6 }, (_, i) => image(`QUJD${i}`));
  const item = boxItem(six);
  assert.equal(item?.images?.length, 4);
  assert.deepEqual(
    item?.images?.map((i) => i.data),
    ["QUJD0", "QUJD1", "QUJD2", "QUJD3"],
  );
});

test("知らない mimeType・空の data・オブジェクトでない要素は画像だけ落とし、他は残す", () => {
  const item = boxItem([
    image(PNG, "image/svg+xml"),
    image("", "image/png"),
    image("<svg onload=alert(1)>", "image/png"),
    "not-an-object",
    null,
    { data: PNG },
    image("AAAA", "image/webp"),
  ]);
  assert.deepEqual(item?.images, [{ data: "AAAA", mimeType: "image/webp" }]);
});

test("復号後が2MiBを超える画像は落とし、他は残す", () => {
  // base64 4文字 = 3バイト。2MiB(=2,097,152バイト)を1バイト超える長さを作る。
  const justUnder = "A".repeat(Math.floor((2 * 1024 * 1024 * 4) / 3));
  const tooBig = `${justUnder}AAAA`;
  const item = boxItem([image(tooBig), image(justUnder)]);
  assert.deepEqual(item?.images, [{ data: justUnder, mimeType: "image/png" }]);
});

test("画像が無い項目は images が undefined(空の枠を描かない)", () => {
  assert.equal(boxItem(undefined)?.images, undefined);
  assert.equal(boxItem([])?.images, undefined);
  assert.equal(boxItem("broken")?.images, undefined);
});

test("中間形式(未 ingest の行)の画像も失わない", () => {
  const parsed = parsePendingRecords([{ key: "k", subject: "s", images: [image()] }]);
  assert.deepEqual(parsed.items[0]?.images, [{ data: PNG, mimeType: "image/png" }]);
});
