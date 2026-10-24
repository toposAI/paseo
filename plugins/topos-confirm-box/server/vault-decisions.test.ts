import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { isNotificationItem } from "../shared/contract.js";
import { foldBoxEvents } from "./box.js";
import {
  answerVaultDecision,
  applyVaultSource,
  bundleNotifications,
  parseDecisionNote,
  parseOptions,
  readVaultDecisions,
} from "./vault-decisions.js";

const NOTE = (id: string, state: string, extra = "") => `---
id: ${id}
state: ${state}
priority: design
raised: 2026-10-22
answered_at: null
route: null
materials: ${state === "waiting_materials" ? "差分の整理" : "null"}
legacy_keys: []
modified_history:
- 2026-10-22 23:06 (user)
---
# 題名 ${id}

## 背景
背景の1行目。
2行目。

## 選択肢と推奨
a 維持(このまま)=推奨 / b 取り消す

## 回答原文と日時
- (未回答)

## 実行状況
- [ ] 待ち
${extra}`;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-decisions-"));
}

function item(over: Partial<ConfirmBoxItem>): ConfirmBoxItem {
  return {
    id: "x",
    kind: "box",
    priority: "normal",
    subrank: 0,
    group: null,
    subject: "s",
    summary: "m",
    background: "",
    source: "src",
    threadRef: null,
    stoppedCount: 0,
    options: [],
    recommended: null,
    state: "new",
    urgency: "normal",
    judgment: false,
    key: null,
    agentId: null,
    workspaceId: null,
    ts: 1,
    ...over,
  };
}

test("parseOptions: 推奨の印を外して id と推奨を取る / 2つ未満は空", () => {
  const r = parseOptions("a 維持(このまま)=推奨 / b 取り消す");
  assert.deepEqual(r.options, [
    { id: "a", label: "維持(このまま)" },
    { id: "b", label: "取り消す" },
  ]);
  assert.equal(r.recommended, "a");
  assert.deepEqual(parseOptions("自由記述").options, []);
});

test("open と waiting_materials だけ読み、answered/superseded は出さない", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "j-1.md"), NOTE("j-1", "open"));
  fs.writeFileSync(path.join(dir, "j-2.md"), NOTE("j-2", "waiting_materials"));
  fs.writeFileSync(path.join(dir, "j-3.md"), NOTE("j-3", "answered"));
  fs.writeFileSync(path.join(dir, "j-4.md"), NOTE("j-4", "superseded"));
  fs.writeFileSync(path.join(dir, "_発言ログ.md"), "x");
  const r = readVaultDecisions({ TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: dir });
  assert.equal(r.error, null);
  assert.deepEqual(r.items.map((i) => i.key).sort(), ["vault:j-1", "vault:j-2"]);
  const w = r.items.find((i) => i.key === "vault:j-2");
  assert.match(w?.summary ?? "", /材料待ち/);
  const o = r.items.find((i) => i.key === "vault:j-1");
  assert.equal(o?.judgment, true);
  assert.equal(o?.recommended, "a");
  assert.equal(o?.priority, "design");
});

test("バックアップ配下は読まない", () => {
  const r = readVaultDecisions({
    TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: "/Users/x/Documents/Obsidian-Git/05_Projects/ユーザー判断",
  });
  assert.match(r.error ?? "", /バックアップ/);
  assert.equal(r.items.length, 0);
});

test("答えるとノートが answered になり、未回答行が回答に置き換わる", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "j-1.md"), NOTE("j-1", "open"));
  const env = { TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: dir };
  answerVaultDecision(
    { key: "vault:j-1", chosenId: "a", chosenLabel: "維持", reason: "" },
    new Date(2026, 9, 24, 20, 5, 9),
    env,
  );
  const text = fs.readFileSync(path.join(dir, "j-1.md"), "utf8");
  assert.match(text, /^state: answered$/m);
  assert.match(text, /^answered_at: 2026-10-24 20:05:09[+-]\d\d:\d\d$/m);
  assert.match(text, /^route: chat$/m);
  assert.match(text, /- 2026-10-24 20:05 \(user: 確認箱で回答\)/);
  assert.match(text, /- 「2026-10-24 20:05 \(確認箱\): 選択 a「維持」」/);
  assert.doesNotMatch(text, /\(未回答\)/);
  assert.match(text, /## 実行状況/);
  assert.equal(readVaultDecisions(env).items.length, 0);
  assert.throws(
    () =>
      answerVaultDecision(
        { key: "vault:j-1", chosenId: "b", chosenLabel: null, reason: "" },
        new Date(),
        env,
      ),
    /上書きしません/,
  );
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.startsWith(".")),
    [],
  );
});

test("不正な key / 外へ出る id は書かない", () => {
  const dir = tmpDir();
  const env = { TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: dir };
  for (const key of ["vault:../evil", "vault:j-1/../../x", "other:j-1"]) {
    assert.throws(() =>
      answerVaultDecision({ key, chosenId: "a", chosenLabel: null, reason: "" }, new Date(), env),
    );
  }
});

test("箱側の旧 judgment 行・旧形式は隠し、permit と通知は残す", () => {
  const legacy = item({ id: "a", judgment: true });
  const opt = item({ id: "b", options: [{ id: "a", label: "A" }] });
  const permit = item({ id: "c", kind: "permit" });
  const note = item({ id: "d", source: "watchdog" });
  const vault = parseDecisionNote(NOTE("j-9", "open"), 5) as ConfirmBoxItem;
  const r = applyVaultSource([legacy, opt, permit, note], [vault]);
  assert.deepEqual(
    r.items.map((i) => i.id),
    ["c", "d", vault.id],
  );
  assert.deepEqual(
    r.hidden.map((i) => i.id),
    ["a", "b"],
  );
});

test("hide イベントで隠れ、unhide で戻る", () => {
  const base = { t: "item", ts: 1, id: "i1", subject: "x" };
  const hidden = foldBoxEvents([base, { t: "hide", id: "i1", ts: 2 }]);
  assert.equal(hidden.size, 0);
  const back = foldBoxEvents([
    base,
    { t: "hide", id: "i1", ts: 2 },
    { t: "unhide", id: "i1", ts: 3 },
  ]);
  assert.equal(back.size, 1);
});

test("同一 source+内容の未読通知を束ね、既読と別内容は束ねない", () => {
  const a1 = item({ id: "1", ts: 1, source: "w", subject: "停止", summary: "m" });
  const a2 = item({ id: "2", ts: 3, source: "w", subject: "停止", summary: "m" });
  const a3 = item({ id: "3", ts: 2, source: "w", subject: "停止", summary: "m", state: "read" });
  const b = item({ id: "4", ts: 4, source: "w", subject: "別", summary: "m" });
  const out = bundleNotifications([a1, a2, a3, b], isNotificationItem);
  assert.deepEqual(out.map((i) => i.id).sort(), ["2", "3", "4"]);
  const rep = out.find((i) => i.id === "2");
  assert.equal(rep?.dupCount, 2);
  assert.deepEqual(rep?.memberIds?.sort(), ["1", "2"]);
});
