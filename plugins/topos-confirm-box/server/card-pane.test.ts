import { strict as assert } from "node:assert";
import test from "node:test";
import {
  cardIdFromSearch,
  paneTargetFromSearch,
  searchWithCard,
  searchWithPane,
  threadIdFromSearch,
  threadUnavailableReason,
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
