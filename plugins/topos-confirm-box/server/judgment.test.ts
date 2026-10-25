/**
 * 判断タブの振り分けの回帰テスト。**許可リスト方式**(明示の判断印 `judgment: true` を持つ項目だけが判断)
 * を固定する。
 *
 * きっかけ: 2026-10-22、判断タブにウォッチドッグのメール通知が通知タブと二重に並んでいた
 * (判断タブは出所 `kind` で絞らず全項目を並べていた)。その後「選択肢がある＝判断」をやめ、
 * 投函側が付ける判断印だけで判定する方式へ変えた(選択肢があっても印の無いものは判断ではない)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  countOpen,
  countUnreadNotifications,
  isJudgmentItem,
  isLegacyOptionItem,
  isNotificationItem,
  judgmentTabRows,
  notificationTabRows,
  REJECT_CHOICE,
  canRejectItem,
  rejectComment,
} from "../shared/contract.js";
import type { ConfirmBoxItem } from "../shared/contract.js";
import { foldBoxEvents, mergeBoxAndPending, parsePendingRecords } from "./box.js";

const OPTIONS = [
  { id: "a", label: "やる" },
  { id: "b", label: "やらない" },
];

function item(over: Partial<ConfirmBoxItem> = {}): ConfirmBoxItem {
  return {
    id: "box:1",
    kind: "box",
    priority: "normal",
    subrank: 0,
    group: null,
    subject: "件名",
    summary: "本文",
    background: "",
    source: "unknown",
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

const MAIL = item({
  id: "box:mail",
  source: "mailtriage_deepseek_safety_net_watchdog",
  subject: "[mailtriage_deepseek_safety_net_watchdog] 110番 無人経路で止まったジョブ",
});

/** 判断印つきの箱の項目(投函側が `kind="judgment"` で投函したもの)。 */
const JUDGMENT = item({ id: "box:judgment", source: "総司令", options: OPTIONS, judgment: true });

/** 印の無い旧形式(判断印の導入前に投函された選択肢つきの項目)。 */
const LEGACY_OPTION = item({ id: "box:legacy", source: "総司令", options: OPTIONS });

const PERMIT = item({ id: "permit:a:p", kind: "permit", agentId: "a" });

test("メール通知(選択肢なし・印なし)は判断タブに入らず、通知タブだけに入る", () => {
  assert.equal(isJudgmentItem(MAIL), false);
  assert.equal(isNotificationItem(MAIL), true);
});

test("(a) 選択肢があっても判断印が無ければ判断タブに出ない", () => {
  assert.equal(isJudgmentItem(LEGACY_OPTION), false);
  assert.equal(isLegacyOptionItem(LEGACY_OPTION), true);
  assert.deepEqual(
    judgmentTabRows([LEGACY_OPTION], { showDone: true, prio: null, newestFirst: false }),
    [],
  );
});

test("(b) 選択肢が無くても判断印があれば判断タブに出る", () => {
  const bare = item({ id: "box:bare", judgment: true });
  assert.equal(isJudgmentItem(bare), true);
  assert.equal(isNotificationItem(bare), false);
  assert.deepEqual(
    judgmentTabRows([bare], { showDone: true, prio: null, newestFirst: false }).map((r) => r.id),
    ["box:bare"],
  );
});

test("(c) permit(承認待ち)は判断印が無くても判断", () => {
  assert.equal(PERMIT.judgment, false);
  assert.equal(isJudgmentItem(PERMIT), true);
  assert.equal(isNotificationItem(PERMIT), false);
});

test("(d) legacy=true で印なしの選択肢つきだけが加わる(並び順は変えない)", () => {
  const rows = [JUDGMENT, LEGACY_OPTION, MAIL, PERMIT];
  const ids = (legacy: boolean) =>
    judgmentTabRows(rows, { showDone: true, prio: null, newestFirst: false, legacy }).map(
      (r) => r.id,
    );
  assert.deepEqual(ids(false), ["box:judgment", "permit:a:p"]);
  assert.deepEqual(ids(true), ["box:judgment", "box:legacy", "permit:a:p"]);
});

test("(e) 印ありも印なしの選択肢つきも通知タブに出ない(選択肢つきのお知らせを判断に見せない)", () => {
  assert.equal(isNotificationItem(JUDGMENT), false);
  // 印なしの選択肢つき = 旧形式。判断タブの「印なし(旧形式)」フィルタでだけ見られる。
  assert.equal(isNotificationItem(LEGACY_OPTION), false);
  assert.deepEqual(
    notificationTabRows([JUDGMENT, LEGACY_OPTION, MAIL], true).map((r) => r.id),
    ["box:mail"],
  );
});

test("(f) countOpen も同じ定義(判断印か permit だけを数え、旧形式は数えない)", () => {
  const rows = [
    MAIL,
    JUDGMENT,
    LEGACY_OPTION,
    item({ id: "box:done", judgment: true, options: OPTIONS, state: "approved" }),
    PERMIT,
    item({ id: "box:notify-read", source: "x", state: "read" }),
  ];
  assert.equal(countOpen(rows), 2);
});

test("バグ報告・子スレ完了まとめは専用タブのみ(判断タブにも通知タブにも出さない)", () => {
  for (const source of ["topos_feedback", "child_thread_report"]) {
    const row = item({ id: `box:${source}`, source });
    assert.equal(isJudgmentItem(row), false);
    assert.equal(isNotificationItem(row), false);
  }
});

test("通知タブに出るものは判断タブ(旧形式フィルタ含む)にも出ない=二重表示しない", () => {
  const rows = [MAIL, JUDGMENT, LEGACY_OPTION, PERMIT];
  const both = { showDone: true, prio: null, newestFirst: false, legacy: true };
  const judgmentIds = new Set(judgmentTabRows(rows, both).map((r) => r.id));
  for (const row of rows.filter(isNotificationItem)) {
    assert.equal(judgmentIds.has(row.id), false);
  }
});

test("通知タブのバッジは未読の通知だけ数える", () => {
  const rows = [
    MAIL,
    JUDGMENT,
    item({ id: "box:mail-read", source: "mailtriage_deepseek_safety_net_watchdog", state: "read" }),
  ];
  assert.equal(countUnreadNotifications(rows), 1);
});

test("判断タブの行(画面と共通の絞り込み)に通知・バグ報告・完了報告は入らない", () => {
  const rows = judgmentTabRows(
    [
      MAIL,
      JUDGMENT,
      PERMIT,
      item({ id: "box:topos_feedback", source: "topos_feedback" }),
      item({ id: "box:child_thread_report", source: "child_thread_report" }),
    ],
    { showDone: true, prio: null, newestFirst: false },
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["box:judgment", "permit:a:p"],
  );
});

test("判断タブの行は「決定済みも表示」と優先度の絞り込みにだけ従う(通知は絞り込みを外しても出ない)", () => {
  const rows = [
    MAIL,
    item({ id: "box:done", judgment: true, options: OPTIONS, state: "approved" }),
    item({ id: "box:blocking", priority: "blocking", judgment: true, options: OPTIONS }),
  ];
  const ids = (o: Parameters<typeof judgmentTabRows>[1]) =>
    judgmentTabRows(rows, o).map((r) => r.id);
  assert.deepEqual(ids({ showDone: false, prio: null, newestFirst: true }), ["box:blocking"]);
  assert.deepEqual(ids({ showDone: true, prio: null, newestFirst: false }), [
    "box:done",
    "box:blocking",
  ]);
  assert.deepEqual(ids({ showDone: true, prio: "normal", newestFirst: false }), ["box:done"]);
});

test("通知タブは緊急を先に、同順位は新しい順(判断タブから外した緊急通知を埋もれさせない)", () => {
  const rows = notificationTabRows(
    [
      item({ id: "box:new-normal", urgency: "normal", ts: 30 }),
      item({ id: "box:urgent-old", urgency: "urgent", ts: 10 }),
      item({ id: "box:old-normal", urgency: "normal", ts: 5 }),
      item({ id: "box:urgent-new", urgency: "urgent", ts: 20 }),
      item({ id: "box:decision", judgment: true, options: OPTIONS, ts: 99 }),
    ],
    true,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["box:urgent-new", "box:urgent-old", "box:new-normal", "box:old-normal"],
  );
  assert.deepEqual(
    notificationTabRows(rows, false).map((r) => r.id),
    ["box:urgent-new", "box:urgent-old", "box:new-normal", "box:old-normal"],
  );
});

test("箱の行・中間形式の行の判断印が ConfirmBoxItem へ引き継がれる", () => {
  const box = [
    ...foldBoxEvents([
      { t: "item", id: "box:j", ts: 1, judgment: true, options: OPTIONS },
      { t: "item", id: "box:n", ts: 2 },
    ]).values(),
  ];
  assert.equal(box.find((i) => i.id === "box:j")?.judgment, true);
  assert.equal(box.find((i) => i.id === "box:n")?.judgment, false);

  const parsed = parsePendingRecords([
    { key: "j", judgment: true, options: OPTIONS },
    { key: "n", options: OPTIONS },
  ]);
  assert.equal(parsed.items.find((i) => i.key === "j")?.judgment, true);
  assert.equal(parsed.items.find((i) => i.key === "n")?.judgment, false);
});

test("追記の判断印(judgment イベント)は箱の項目に効き、item 行の内容は変えない", () => {
  const records = [
    { t: "item", id: "box:x", ts: 1, subject: "旧判断", options: OPTIONS, key: "k1" },
    { t: "judgment", id: "box:x", ts: 2, by: "backfill" },
  ];
  const box = [...foldBoxEvents(records).values()];
  assert.equal(box[0].judgment, true);
  assert.equal(box[0].subject, "旧判断");
});

test("key つきの判断印は、後から箱へ流れ込んだ同じ key の項目にも効く", () => {
  // 付与が先・item が後(中間形式の行への付与 → 後日の ingest)でも印が失われない
  const box = [
    ...foldBoxEvents([
      { t: "judgment", key: "k2", ts: 1 },
      { t: "item", id: "box:y", ts: 2, options: OPTIONS, key: "k2" },
    ]).values(),
  ];
  assert.equal(box[0].judgment, true);
});

test("pending の判断印は箱に同じ key が無い行にだけ効く(箱側の状態を上書きしない)", () => {
  const box = [item({ id: "box:has", key: "k3" })];
  const parsed = parsePendingRecords([
    { key: "k3", subject: "箱にある方", options: OPTIONS },
    { key: "k4", subject: "箱に無い方", options: OPTIONS },
    { t: "judgment", id: "pending:k3" },
    { t: "judgment", key: "k4" },
  ]);
  const merged = mergeBoxAndPending(box, parsed.items, parsed.overrides);
  assert.equal(merged.find((i) => i.key === "k3")?.judgment, false);
  assert.equal(merged.find((i) => i.key === "k4")?.judgment, true);
});

test("画面側は自前の絞り込みを書かず、共通の judgmentTabRows を使う", () => {
  const view = readFileSync(new URL("../client/ConfirmBoxView.tsx", import.meta.url), "utf8");
  assert.match(view, /judgmentTabRows\(/);
  assert.doesNotMatch(view, /isJudgmentItem\(/);
});

test("却下: 判断項目(key あり・permit でない)だけに出し、コメントは空白だけを不可にする", () => {
  const base = [
    ...foldBoxEvents([
      { t: "item", id: "box:j", ts: 1, judgment: true, key: "vault:j-1", options: OPTIONS },
    ]).values(),
  ][0];
  assert.equal(canRejectItem(base), true);
  assert.equal(canRejectItem({ ...base, key: "pending:x" }), false);
  assert.equal(canRejectItem({ ...base, key: "" }), false);
  assert.equal(canRejectItem({ ...base, judgment: false }), false);
  assert.equal(canRejectItem({ ...base, kind: "permit" }), false);
  assert.equal(rejectComment("   \n"), null);
  assert.equal(rejectComment("  解決済み "), "解決済み");
});

test("却下(chosen=__reject の決定行)は中間形式の判断項目を未決から外す", () => {
  const parsed = parsePendingRecords([
    { key: "k", judgment: true, options: OPTIONS },
    { t: "decision", key: "k", chosen: REJECT_CHOICE, reason: "不要" },
  ]);
  assert.equal(parsed.decidedKeys.has("k"), true);
});
