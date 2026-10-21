/**
 * カードチャット(確認箱の自由記述欄)の往復テスト。2026-10-22。
 *
 * ここで固定したいのは**書き手と読み手の噛み合わせ**だけ:
 * - UI は質問と受領(ack)を**1回の append**で書く(間にワーカーが割り込むと ack が二重になる)
 * - 応答ワーカー(Python)が書く `t:"reply"` 行は `re`(質問の client_message_id)だけで
 *   照合できる(id が `pending:<key>` でも、key を持たない行でも表示される)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ACK_TEXT, readCardChat, sayToCard } from "./cardchat.ts";

let dir = "";

function eventsFile(): string {
  return fs
    .readdirSync(dir)
    .filter((name) => /^events-\d{6}\.jsonl$/.test(name))
    .map((name) => path.join(dir, name))
    .sort()
    .at(-1) as string;
}

function lines(): Record<string, unknown>[] {
  return fs
    .readFileSync(eventsFile(), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function appendRaw(row: Record<string, unknown>): void {
  fs.appendFileSync(eventsFile(), `${JSON.stringify(row)}\n`, { encoding: "utf-8" });
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardchat-test-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sayToCard", () => {
  it("writes the question and the ack in a single append with the same ts", () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cardchat-ack-"));
    try {
      const out = sayToCard(dir2, { id: "pending:k1", key: "k1" }, "  なぜ推奨?  ");
      assert.equal(out.ok, true);
      const file = fs
        .readdirSync(dir2)
        .filter((n) => /^events-\d{6}\.jsonl$/.test(n))
        .map((n) => path.join(dir2, n))
        .sort()
        .at(-1) as string;
      const rows = fs
        .readFileSync(file, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].t, "chat");
      assert.equal(rows[1].t, "reply");
      assert.equal(rows[1].by, "ack");
      assert.equal(rows[1].re, rows[0].client_message_id);
      assert.equal(rows[0].ts, rows[1].ts); // 同じwrite・同じ時刻
      assert.equal(rows[0].question, "なぜ推奨?"); // 連続空白は畳む
      assert.equal(rows[1].text, ACK_TEXT);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("refuses an item without id (the box needs it to fold replies)", () => {
    assert.equal(sayToCard(dir, { id: "" }, "q").ok, false);
    assert.equal(sayToCard(dir, { id: "i1" }, "   ").ok, false);
  });
});

describe("readCardChat", () => {
  it("shows the worker reply matched only by re (no id/key on the reply row)", () => {
    sayToCard(dir, { id: "pending:k9", key: "k9" }, "この修正で次は?");
    const chat = lines().find((r) => r.t === "chat") as Record<string, unknown>;
    const cid = chat.client_message_id as string;

    // 応答ワーカー(confirm_box_reply_worker.py)が書く形そのもの:
    // id は項目の id、re は質問の client_message_id、key は持たないことがある。
    appendRaw({
      t: "reply",
      id: "pending:k9",
      key: null,
      ts: Date.now(),
      re: cid,
      by: "worker",
      text: "次はテストを流してください",
    });

    const msgs = readCardChat(dir, { id: "pending:k9", key: "k9" });
    assert.deepEqual(
      msgs.map((m) => m.by),
      ["user", "ack", "worker"],
    );
    assert.equal(msgs[1].text, ACK_TEXT);
    assert.equal(msgs[2].text, "次はテストを流してください");
  });

  it("shows a reply whose id is synthetic (legacy:<cid>) by matching re only", () => {
    // 応答ワーカーは、項目id を持たない質問には `legacy:<client_message_id>` を付ける。
    // この行は id でも key でも一致しないので、`re` の照合が無いと表示されない。
    sayToCard(dir, { id: "pending:k8", key: "k8" }, "idが無い項目の質問");
    const chat = lines().find(
      (r) => r.t === "chat" && r.question === "idが無い項目の質問",
    ) as Record<string, unknown>;
    appendRaw({
      t: "reply",
      id: `legacy:${chat.client_message_id as string}`,
      key: null,
      ts: Date.now(),
      re: chat.client_message_id,
      by: "worker",
      text: "合成IDでも表示される",
    });
    const msgs = readCardChat(dir, { id: "pending:k8", key: "k8" });
    assert.ok(msgs.some((m) => m.text === "合成IDでも表示される"));
  });

  it("does not show another card's replies", () => {
    const msgs = readCardChat(dir, { id: "pending:other" });
    assert.deepEqual(msgs, []);
  });

  it("ignores rows whose t is unknown (the box's forward-compat contract)", () => {
    sayToCard(dir, { id: "pending:k7", key: "k7" }, "q7");
    appendRaw({ t: "future-event", id: "pending:k7", ts: Date.now() });
    const msgs = readCardChat(dir, { id: "pending:k7", key: "k7" });
    assert.equal(msgs.length, 2); // chat + ack のみ
  });
});
