/**
 * 完了箱C(完了報告の窓口)の「未読」の判定(`server/window-unread.ts`)。
 *
 * 既読は Paseo の attention が消えたかどうかだけで決める(自前の既読位置を持たない)。
 * ここで固定するのは、その写像・対象の絞り込み・分からないときに動かさないこと。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChildThread } from "../shared/child-threads.js";
import {
  applyWindowUnread,
  isUnreadWindow,
  progressWindowDir,
  readWindowId,
} from "./window-unread.js";
import type { ListedAgentLike } from "./unregistered-threads.js";

const WINDOW = "03aeafd1-a65f-455a-9892-c7b9cf08e506";

function row(agentId: string, over: Partial<ChildThread> = {}): ChildThread {
  return {
    agentId,
    title: "完了箱C",
    status: "実装中",
    machineState: "idle",
    request: "",
    summaryItemId: null,
    nocard: false,
    summary: null,
    summaryState: null,
    summaryAcked: false,
    updatedAt: 1,
    parentAgentId: null,
    parentTitle: null,
    pinned: false,
    coordinator: false,
    parentOpenable: false,
    access: "open",
    ...over,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "window-unread-"));
}

test("窓口の id は window_id から読む(改行・空白は落とす)", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "window_id"), "03aeafd\n");
  assert.equal(readWindowId(dir), "03aeafd");
  // 空・壊れた値・ファイル無しは null(推測しない)
  fs.writeFileSync(path.join(dir, "window_id"), "  \n");
  assert.equal(readWindowId(dir), null);
  fs.writeFileSync(path.join(dir, "window_id"), "../../etc/passwd");
  assert.equal(readWindowId(dir), null);
  assert.equal(readWindowId(path.join(dir, "no-such-dir")), null);
});

test("置き場は PROGRESS_WINDOW_DIR で差し替えられる(既定は本番の1か所)", () => {
  assert.equal(progressWindowDir({ PROGRESS_WINDOW_DIR: "/tmp/x" }), "/tmp/x");
  assert.match(progressWindowDir({}), /toposai\/progress_window$/);
});

test("未読の材料は Paseo の attention だけ(承認待ち・失敗・実行中は未読にしない)", () => {
  // ターンが終わって、まだ開いていない
  assert.equal(isUnreadWindow({ id: WINDOW, status: "idle", requiresAttention: true }), true);
  // 承認待ち(橙)と失敗(赤)は別の色が担当する
  assert.equal(
    isUnreadWindow({
      id: WINDOW,
      status: "idle",
      requiresAttention: true,
      attentionReason: "permission",
    }),
    false,
  );
  assert.equal(
    isUnreadWindow({
      id: WINDOW,
      status: "idle",
      requiresAttention: true,
      attentionReason: "error",
    }),
    false,
  );
  // まだ書いている最中
  assert.equal(isUnreadWindow({ id: WINDOW, status: "running", requiresAttention: true }), false);
  // 読んだ/材料が無い
  assert.equal(isUnreadWindow({ id: WINDOW, status: "idle", requiresAttention: false }), false);
  assert.equal(isUnreadWindow({ id: WINDOW, status: "idle" }), false);
  assert.equal(isUnreadWindow(undefined), false);
});

test("未読なら印と緑の点、既読なら「待機中」に戻す(窓口の行だけ)", () => {
  const rows = [row(WINDOW), row("other-0000")];
  const agent: ListedAgentLike = { id: WINDOW, status: "idle", requiresAttention: true };

  const unread = applyWindowUnread(rows, [agent], "03aeafd");
  assert.equal(unread[0]?.unread, true);
  assert.equal(unread[0]?.stateDot, "attention");
  // 待機が正常な窓口なので、登録簿の語彙外 status で「実装中」と出さない
  assert.equal(unread[0]?.status, "待機中");
  // 他の行は同じ参照のまま(数秒ごとの取得で再描画を増やさない)
  assert.equal(unread[1], rows[1]);

  const read = applyWindowUnread(rows, [{ id: WINDOW, status: "idle" }], "03aeafd");
  assert.equal(read[0]?.unread, false);
  assert.equal(read[0]?.status, "待機中");

  // 同じ状態をもう一度通しても参照が変わらない(ポーリングごとの再描画を増やさない)
  assert.equal(applyWindowUnread(unread, [agent], "03aeafd")[0], unread[0]);
});

test("報告を書いている最中(running)と、窓口が一覧に居ないときは動かさない", () => {
  const rows = [row(WINDOW)];
  const running = applyWindowUnread(
    rows,
    [{ id: WINDOW, status: "running", requiresAttention: true }],
    "03aeafd",
  );
  assert.equal(running[0]?.status, "実装中");
  assert.equal(running[0]?.unread, undefined);
  // 一覧に居ない=分からない。行はそのまま(勝手に「読んだ」ことにしない)
  assert.equal(applyWindowUnread(rows, [], "03aeafd")[0], rows[0]);
  // window_id が読めないときも何もしない
  assert.equal(applyWindowUnread(rows, [{ id: WINDOW, status: "idle" }], null)[0], rows[0]);
});

test("承認待ち(橙)と失敗(赤)の行は触らない(橙は判断待ち専用を壊さない)", () => {
  const rows = [row(WINDOW, { status: "ユーザー判断待ち", stateDot: "needs_input" })];
  const out = applyWindowUnread(rows, [{ id: WINDOW, status: "idle" }], "03aeafd");
  assert.equal(out[0], rows[0]);
  const failed = [row(WINDOW, { stateDot: "failed" })];
  assert.equal(
    applyWindowUnread(failed, [{ id: WINDOW, status: "idle" }], "03aeafd")[0],
    failed[0],
  );
});

test("完了の行は「待機中」へ下げない(終わった窓口を動いているようにも見せない)", () => {
  const [done] = applyWindowUnread(
    [row(WINDOW, { status: "完了" })],
    [{ id: WINDOW, status: "idle" }],
    "03aeafd",
  );
  assert.equal(done?.status, "完了");
});

test("意味のある語彙は上書きしない(語彙外の「実装中」だけ「待機中」に直す)", () => {
  // 登録簿の正規語彙。帯を勝手に「待機中」へ書き換えない(出口レビュー第2ラウンド指摘7)
  const [waiting] = applyWindowUnread(
    [row(WINDOW, { status: "ユーザー判断待ち" })],
    [{ id: WINDOW, status: "idle", requiresAttention: true }],
    "03aeafd",
  );
  assert.equal(waiting?.status, "ユーザー判断待ち");
  assert.equal(waiting?.unread, true); // 未読の印そのものは付く

  // エラー・承認待ちの窓口は、点が取れていなくても帯を触らない(赤字・橙字を隠さない)
  for (const reason of ["error", "permission"]) {
    const rows = [row(WINDOW, { status: "実装中" })];
    const out = applyWindowUnread(
      rows,
      [{ id: WINDOW, status: "idle", requiresAttention: true, attentionReason: reason }],
      "03aeafd",
    );
    assert.equal(out[0], rows[0]);
  }
});
