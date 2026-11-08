/** 確認箱の一覧読み込みを「イベントファイルが変わっていなければ使い回す」ようにした試験(2026-11-08)。
 *
 * ねらい: 画面が30秒ごと(失敗時は5秒ごと)に取り直すたび、数千行のイベントを毎回パースし直していた。
 * 使い回しで壊してはいけないのは次の3つなので、それを確かめる。
 * - 同じ状態なら同じ項目が返る
 * - 追記があったら必ず読み直す(古い一覧を返さない)
 * - 呼び手が項目を書き換えても、次に読む人の記録を汚さない
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { eventsFileName } from "./ack.js";
import { readConfirmBox } from "./box.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-memo-"));
}

function eventsPath(dir: string): string {
  return path.join(dir, eventsFileName(Date.now()));
}

function append(dir: string, record: Record<string, unknown>): void {
  fs.appendFileSync(eventsPath(dir), `${JSON.stringify(record)}\n`, "utf8");
}

function putItem(dir: string, id: string, ts = 1_700_000_000_000): void {
  append(dir, { t: "item", id, ts, subject: `件名-${id}` });
}

test("同じ状態で2回読むと、同じ項目が返る(2回目は使い回し)", () => {
  const dir = tmpDir();
  putItem(dir, "m1");
  putItem(dir, "m2");

  const first = readConfirmBox(dir);
  const second = readConfirmBox(dir);

  assert.deepEqual(
    second.items.map((i) => i.id),
    first.items.map((i) => i.id),
  );
  assert.deepEqual(
    second.items.map((i) => i.subject),
    first.items.map((i) => i.subject),
  );
  // 使い回しでも中身は同じ
  assert.equal(second.items.find((i) => i.id === "m2")?.subject, "件名-m2");
});

test("後から投函された項目は、次の読み込みに出る(古い一覧を返さない)", () => {
  const dir = tmpDir();
  putItem(dir, "m3");
  assert.equal(
    readConfirmBox(dir).items.some((i) => i.id === "late"),
    false,
  );

  putItem(dir, "late", 1_700_000_003_000);

  const after = readConfirmBox(dir);
  assert.equal(
    after.items.some((i) => i.id === "late"),
    true,
    "追記があったのに読み直していない",
  );
});

test("後から来た hide も次の読み込みに効く(隠した項目を出し続けない)", () => {
  const dir = tmpDir();
  putItem(dir, "m4");
  assert.equal(
    readConfirmBox(dir).items.some((i) => i.id === "m4"),
    true,
  );

  append(dir, { t: "hide", id: "m4" });

  assert.equal(
    readConfirmBox(dir).items.some((i) => i.id === "m4"),
    false,
    "hide を追記したのに隠れていない",
  );
});

test("返り値を書き換えても、次の読み込みは汚れない", () => {
  const dir = tmpDir();
  putItem(dir, "m5");

  const first = readConfirmBox(dir);
  const item = first.items.find((i) => i.id === "m5");
  assert.ok(item);
  item.state = "approved";
  item.subject = "書き換え";

  // ファイルは変わっていないので、使い回しの道を通る
  const second = readConfirmBox(dir);
  const again = second.items.find((i) => i.id === "m5");
  assert.equal(again?.state, "new");
  assert.equal(again?.subject, "件名-m5");
});

test("rerank(並べ替え)も使い回しで失われない", () => {
  const dir = tmpDir();
  putItem(dir, "m6");
  putItem(dir, "m7");
  append(dir, { t: "rerank", id: "m7", priority: "blocking", subrank: -2 });

  readConfirmBox(dir); // 1回目で記録する
  const second = readConfirmBox(dir); // 2回目は使い回し

  assert.equal(second.reranks.has("m7"), true, "使い回しで rerank が落ちている");
  assert.equal(second.reranks.get("m7")?.priority, "blocking");
  assert.equal(second.reranks.get("m7")?.subrank, -2);
});
