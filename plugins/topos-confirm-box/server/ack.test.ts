import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAck, appendAckAll, eventsFileName } from "./ack.js";
import { readConfirmBox } from "./box.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-ack-"));
}

/** 箱の item を1件だけ置く(`events-YYYYMM.jsonl` の正本契約)。 */
function putItem(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: "item", id, ts: 1_700_000_000_000, subject: "s", ...extra });
  fs.writeFileSync(path.join(dir, eventsFileName(Date.now())), `${line}\n`, "utf8");
}

test("ack(read) は箱の state を read にする", () => {
  const dir = tmpDir();
  putItem(dir, "a1");
  appendAck(dir, "a1", "read", 1_700_000_001_000);
  const { items } = readConfirmBox(dir);
  assert.equal(items.find((i) => i.id === "a1")?.state, "read");
});

test("ack(approve) は承認として畳まれる", () => {
  const dir = tmpDir();
  putItem(dir, "a2");
  appendAck(dir, "a2", "approve", 1_700_000_002_000);
  const { items } = readConfirmBox(dir);
  assert.equal(items.find((i) => i.id === "a2")?.state, "approved");
});

test("ackall は before 以前の未読だけを既読にする(後から来た項目は未読のまま)", () => {
  const dir = tmpDir();
  putItem(dir, "old", { ts: 1_700_000_000_000 });
  appendAckAll(dir, 1_700_000_001_000);
  // 同じファイルへ新しい項目を追記(= ackall より後)
  fs.appendFileSync(
    path.join(dir, eventsFileName(Date.now())),
    `${JSON.stringify({ t: "item", id: "new", ts: 1_700_000_002_000, subject: "s" })}\n`,
    "utf8",
  );
  const { items } = readConfirmBox(dir);
  assert.equal(items.find((i) => i.id === "old")?.state, "read");
  assert.equal(items.find((i) => i.id === "new")?.state, "new");
});

test("id が空なら書かない(黙って成功にしない)", () => {
  const dir = tmpDir();
  assert.throws(() => appendAck(dir, "  ", "read"));
});

test("追記は既存行を消さない(読んで書き戻さない)", () => {
  const dir = tmpDir();
  putItem(dir, "keep");
  appendAck(dir, "keep", "read", 1_700_000_003_000);
  appendAck(dir, "keep", "approve", 1_700_000_004_000);
  const lines = fs
    .readFileSync(path.join(dir, eventsFileName(Date.now())), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 3);
});
