import { strict as assert } from "node:assert";
import test from "node:test";
import {
  cardIdFromSearch,
  paneTargetFromSearch,
  searchWithCard,
  searchWithPane,
  shouldFallbackToCoordinator,
  shouldSwitchPaneOnCardPress,
  threadIdFromSearch,
  threadUnavailableReason,
  withCardHeader,
} from "../shared/card-pane.js";

test("card パラメータを読み出す(先頭の?の有無どちらも)", () => {
  assert.equal(cardIdFromSearch("?card=abc123"), "abc123");
  assert.equal(cardIdFromSearch("card=abc123"), "abc123");
});

test("card が無い・空・別名だけなら null", () => {
  assert.equal(cardIdFromSearch(""), null);
  assert.equal(cardIdFromSearch("?other=1"), null);
  assert.equal(cardIdFromSearch("?card="), null);
  assert.equal(cardIdFromSearch("?card=%20"), null);
});

test("card だけを差し替え、他のクエリは残す", () => {
  assert.equal(searchWithCard("?a=1&card=old", "new"), "?a=1&card=new");
  assert.equal(searchWithCard("?a=1", "new"), "?a=1&card=new");
  assert.equal(searchWithCard("?card=old&b=2", "new"), "?card=new&b=2");
});

test("card=null で card だけを消す", () => {
  assert.equal(searchWithCard("?a=1&card=old", null), "?a=1");
  assert.equal(searchWithCard("?card=old", null), "");
  assert.equal(searchWithCard("", null), "");
});

test("IDに記号が入っても往復できる", () => {
  const id = "permit:agent-1:request/2";
  assert.equal(cardIdFromSearch(searchWithCard("?x=1", id)), id);
});

// ---------------------------------------------------------------- スレ直開き(2026-10-23)

test("thread パラメータを読み出す", () => {
  assert.equal(threadIdFromSearch("?thread=agent-1"), "agent-1");
  assert.equal(threadIdFromSearch("?thread="), null);
  assert.equal(threadIdFromSearch("?card=x"), null);
});

test("ペインの相手は thread を先に見る(同時に載っていたらスレが勝つ)", () => {
  assert.deepEqual(paneTargetFromSearch("?card=c1"), { kind: "card", id: "c1" });
  assert.deepEqual(paneTargetFromSearch("?thread=a1"), { kind: "thread", id: "a1" });
  assert.deepEqual(paneTargetFromSearch("?card=c1&thread=a1"), { kind: "thread", id: "a1" });
  assert.equal(paneTargetFromSearch("?other=1"), null);
});

test("searchWithPane は開く側の片方を必ず落とす(undefined だけが触らない)", () => {
  assert.equal(searchWithPane("?card=c1&x=1", { card: null, thread: "a1" }), "?x=1&thread=a1");
  assert.equal(searchWithPane("?thread=a1&x=1", { card: "c1", thread: null }), "?x=1&card=c1");
  assert.equal(searchWithPane("?card=c1", { card: null, thread: null }), "");
  assert.equal(searchWithPane("?card=c1&a=1", { thread: "t" }), "?card=c1&a=1&thread=t");
  assert.equal(searchWithPane("?card=c1", { card: " " }), "");
});

test("閉じている時の文言。不明(null)は「閉じています」と言い換えない", () => {
  assert.equal(threadUnavailableReason(null, "card"), null);
  assert.equal(threadUnavailableReason("open", "card"), null);
  assert.equal(threadUnavailableReason("thread-archived", "card"), "投函元が閉じています");
  assert.equal(threadUnavailableReason("thread-archived", "thread"), "担当スレが閉じています");
  assert.match(
    threadUnavailableReason("workspace-archived", "card") ?? "",
    /^投函元が閉じています/,
  );
  assert.equal(threadUnavailableReason("workspace-archived", "thread"), "担当スレが閉じています");
});

test("総司令塔への振り替え: カードで参照無し/閉じている時だけ。不明・生きている・スレ直接は振り替えない", () => {
  const f = shouldFallbackToCoordinator;
  assert.equal(f({ hasCard: true, agentId: null, closedText: null }), true);
  assert.equal(f({ hasCard: true, agentId: "a1", closedText: "投函元が閉じています" }), true);
  assert.equal(f({ hasCard: true, agentId: "a1", closedText: null }), false);
  assert.equal(f({ hasCard: false, agentId: "a1", closedText: "担当スレが閉じています" }), false);
  assert.equal(f({ hasCard: false, agentId: null, closedText: null }), false);
});

test("withCardHeader: 先頭に題名とID、本文があれば続けて、利用者の文は最後", () => {
  const out = withCardHeader("どういう意味?", { id: "c9", subject: "題名X", background: "背景Y" });
  assert.equal(
    out,
    "【確認箱カード】題名X(ID: c9)\n[カード本文]\n背景Y\n\n[ユーザーの発言]\nどういう意味?",
  );
  assert.equal(
    withCardHeader("q", { id: "c9", subject: "題名X" }),
    "【確認箱カード】題名X(ID: c9)\n\n[ユーザーの発言]\nq",
  );
});

test("カード本体のタップ: ペインが開いている間だけ、別のカードへ切り替える", () => {
  assert.equal(shouldSwitchPaneOnCardPress(false, false), false); // 閉じている=開かない(従来動作)
  assert.equal(shouldSwitchPaneOnCardPress(true, false), true); // 開いていて別のカード=切替
  assert.equal(shouldSwitchPaneOnCardPress(true, true), false); // 既に出ているカード=何もしない
});
