import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConfirmBoxItem } from "../shared/contract.js";
import {
  STALE_MS,
  deriveProgress,
  loadProgressContext,
  type ProgressContext,
} from "./feedback-progress.js";

const NOW = 1_800_000_000_000;
const RID = "fb-20261021-144608-bd3ba7";

const rep = (over: Record<string, unknown> = {}) => ({
  id: RID,
  status: "new",
  ts: NOW - 3600_000,
  reply: null as string | null,
  ...over,
});
const item = (over: Partial<ConfirmBoxItem> = {}) =>
  ({
    id: "it1",
    source: "feedback_auto",
    key: `fb-${RID}`,
    state: "new",
    ...over,
  }) as ConfirmBoxItem;
const ctx = (over: Partial<ProgressContext> = {}): ProgressContext => ({
  intake: {},
  approvalItems: {},
  boxItems: [],
  now: NOW,
  ...over,
});

test("台帳なし・新しい報告は受付", () => {
  assert.equal(deriveProgress(rep(), ctx()).stage, "received");
});

test("受付から24時間、着手記録なしは放置", () => {
  assert.equal(deriveProgress(rep({ ts: NOW - STALE_MS - 1 }), ctx()).stage, "stale");
});

test("spawned は調査中で子スレidを出す。24時間超で確認箱にも無ければ放置", () => {
  const intake = { [RID]: { state: "spawned", agent_id: "1d7d8dc6-xxxx", at: NOW / 1000 - 60 } };
  const p = deriveProgress(rep(), ctx({ intake }));
  assert.equal(p.stage, "investigating");
  assert.equal(p.threadId, "1d7d8dc6-xxxx");
  const old = { [RID]: { state: "spawned", at: (NOW - STALE_MS - 1) / 1000 } };
  assert.equal(deriveProgress(rep(), ctx({ intake: old })).stage, "stale");
});

test("gave_up は放置", () => {
  assert.equal(
    deriveProgress(rep(), ctx({ intake: { [RID]: { state: "gave_up" } } })).stage,
    "stale",
  );
});

test("確認箱に未決の項目があれば判断待ち(調査中より優先)", () => {
  const p = deriveProgress(
    rep(),
    ctx({ intake: { [RID]: { state: "spawned", at: NOW / 1000 } }, boxItems: [item()] }),
  );
  assert.equal(p.stage, "awaiting_decision");
  assert.equal(p.itemId, "it1");
});

test("key は報告IDそのものでも引ける", () => {
  assert.equal(
    deriveProgress(rep(), ctx({ boxItems: [item({ key: RID })] })).stage,
    "awaiting_decision",
  );
});

test("承認済みで工程が残っていれば反映中、全done なら完了待ち、returned は放置", () => {
  const approved = item({ state: "approved" });
  const mk = (steps: Record<string, { state: string }>) =>
    ctx({ boxItems: [approved], approvalItems: { it1: { steps } } });
  assert.equal(
    deriveProgress(rep(), mk({ reflect: { state: "done" }, r: { state: "pending" } })).stage,
    "applying",
  );
  assert.equal(deriveProgress(rep(), mk({ "reply:x": { state: "done" } })).stage, "done");
  assert.equal(deriveProgress(rep(), mk({ reflect: { state: "returned" } })).stage, "stale");
  assert.equal(deriveProgress(rep(), ctx({ boxItems: [approved] })).stage, "applying");
});

test("status が done/rejected なら完了+アーカイブ。返信済みを添える", () => {
  const d = deriveProgress(rep({ status: "done", reply: "ありがとう" }), ctx());
  assert.equal(d.stage, "done");
  assert.equal(d.archived, true);
  assert.match(d.detail, /返信済み/);
  assert.equal(deriveProgress(rep({ status: "rejected" }), ctx()).archived, true);
  assert.equal(deriveProgress(rep({ status: "will_do" }), ctx()).archived, false);
});

test("却下・保留・reflect投入のみは正直に出す", () => {
  const approved = item({ state: "approved" });
  const rej = ctx({
    boxItems: [approved],
    approvalItems: { it1: { chosen: "reject", steps: {} } },
  });
  assert.match(deriveProgress(rep(), rej).detail, /見送り/);
  assert.equal(
    deriveProgress(rep({ status: "hold" }), ctx({ boxItems: [approved] })).detail,
    "保留中",
  );
  const q = ctx({
    boxItems: [approved],
    approvalItems: { it1: { chosen: "both", steps: { reflect: { state: "done" } } } },
  });
  assert.equal(deriveProgress(rep(), q).stage, "applying");
});

test("他ソースの項目は無視し、台帳が壊れていれば受付に倒す", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbp-"));
  fs.writeFileSync(path.join(dir, "feedback_intake_ledger.json"), "{broken");
  const c = loadProgressContext([item({ source: "other" })], NOW, dir);
  assert.equal(c.boxItems.length, 0);
  assert.deepEqual(c.intake, {});
  assert.equal(deriveProgress(rep(), c).stage, "received");
});
