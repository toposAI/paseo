import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyReranks, parseReranks, readConfirmBox } from "./box.js";
import { parseDecisionNote } from "./vault-decisions.js";

const card = (sub: string) => `---
id: j-20261026-a-abc123
state: open
priority: design
${sub}legacy_keys: []
---
# 題名

## 背景
b
`;

test("カードの frontmatter subrank を読む(無い・不正は0)", () => {
  assert.equal(parseDecisionNote(card("subrank: -3\n"), 1)?.subrank, -3);
  assert.equal(parseDecisionNote(card("subrank: 7\n"), 1)?.subrank, 7);
  assert.equal(parseDecisionNote(card(""), 1)?.subrank, 0);
  assert.equal(parseDecisionNote(card("subrank: x\n"), 1)?.subrank, 0);
});

test("parseReranks: 後勝ち・片方だけ・不正値は無視", () => {
  const m = parseReranks([
    { t: "rerank", id: "a", subrank: 5 },
    { t: "rerank", id: "a", priority: "blocking" },
    { t: "rerank", key: "k1", subrank: 1.5 },
    { t: "rerank", key: "k2", priority: "urgent" },
    { t: "rerank", subrank: 3 },
    { t: "item", id: "z", subrank: 9 },
  ]);
  assert.deepEqual(m.get("a"), { subrank: 5, priority: "blocking" });
  assert.equal(m.has("k1"), false);
  assert.equal(m.has("k2"), false);
  assert.equal(m.size, 1);
});

test("readConfirmBox: 追記専用の rerank で並びが変わり、item行は書き換わらない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerank-"));
  const ev = path.join(dir, "events-202610.jsonl");
  const row = (id: string) =>
    JSON.stringify({ t: "item", id, ts: 100, priority: "design", subject: id });
  fs.writeFileSync(
    ev,
    [row("b1"), row("b2"), row("b3"), JSON.stringify({ t: "rerank", id: "b3", subrank: -2 })].join(
      "\n",
    ) + "\n",
  );
  const before = fs.readFileSync(ev, "utf8");
  const r = readConfirmBox(dir);
  assert.equal(r.items[0].id, "b3");
  assert.equal(r.items[0].subrank, -2);
  assert.equal(fs.readFileSync(ev, "utf8"), before);
  const again = applyReranks(r.items, new Map([["b1", { subrank: -9 }]]));
  assert.equal(again.find((i) => i.id === "b1")?.subrank, -9);
});
