import { strict as assert } from "node:assert";
import test from "node:test";
import {
  cardIdFromSearch,
  attemptDelivery,
  deliveryTargets,
  paneTargetFromSearch,
  searchWithCard,
  searchWithPane,
  shouldFallbackToCoordinator,
  shouldSwitchPaneOnCardPress,
  threadIdFromSearch,
  threadUnavailableReason,
  withCardHeader,
  isUrgentCardChat,
  URGENT_CARD_CHAT_MARKERS,
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

test("総司令塔への振り替え: カードで参照無し/閉じている時。生きている・スレ直接は振り替えない", () => {
  const f = shouldFallbackToCoordinator;
  // 投函元がたどれないカード(null)も総司令塔が引き取る(送信不可にしない)
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

test("pickDockTarget: 常駐スレが生きていればそれ、閉じていれば総司令塔、確認中は決めない", async () => {
  const { pickDockTarget } = await import("../shared/card-pane.js");
  assert.deepEqual(pickDockTarget({ fixedId: "f", fixedAlive: true, coordinatorId: "c" }), {
    agentId: "f",
    viaCoordinator: false,
    pending: false,
  });
  assert.deepEqual(pickDockTarget({ fixedId: "f", fixedAlive: null, coordinatorId: "c" }), {
    agentId: null,
    viaCoordinator: false,
    pending: true,
  });
  assert.deepEqual(pickDockTarget({ fixedId: "f", fixedAlive: false, coordinatorId: "c" }), {
    agentId: "c",
    viaCoordinator: true,
    pending: false,
  });
  assert.deepEqual(pickDockTarget({ fixedId: null, fixedAlive: false, coordinatorId: undefined }), {
    agentId: null,
    viaCoordinator: true,
    pending: true,
  });
  assert.equal(
    pickDockTarget({ fixedId: "f", fixedAlive: false, coordinatorId: null }).agentId,
    null,
  );
});

// 2026-11-06 ユーザー逐語「投稿元たどれないなら、総司令塔が引き取るってなってるでしょ」
// 「閉じていれば復元して届ける」: 配送の候補(投函元 → 総司令塔)と、どこにも届かない時の扱い。
// 「復元」は送信そのもの(`send` がアーカイブを解除する)なので、候補は「送る順番」になる。
test("配送: 投函元が生きていれば投函元が第一候補", () => {
  assert.deepEqual(deliveryTargets({ originId: "o", coordinatorId: "c" }), [
    { id: "o", via: "origin" },
    { id: "c", via: "coordinator" },
  ]);
});

test("配送: 投函元が閉じていても投函元を先に試す(送信が復元を兼ねる)", () => {
  // 候補の並びは生死に依存しない。`send` が解除して届けるので、届かなければ次の候補へ進む。
  assert.deepEqual(deliveryTargets({ originId: "o", coordinatorId: null }), [
    { id: "o", via: "origin" },
  ]);
});

test("配送: 復元も送信もできなかった時だけ総司令塔が使われる", () => {
  const targets = deliveryTargets({ originId: "o", coordinatorId: "c" });
  // 実際の送信は呼ぶ側のループ。投函元で失敗したら2番目(総司令塔)が残っていること。
  assert.equal(targets[1]?.id, "c");
  assert.equal(targets[1]?.via, "coordinator");
});

test("配送: 投函元が無ければ総司令塔だけ", () => {
  assert.deepEqual(deliveryTargets({ originId: null, coordinatorId: "c" }), [
    { id: "c", via: "coordinator" },
  ]);
});

test("配送: 投函元と総司令塔が同じなら二重に送らない", () => {
  assert.deepEqual(deliveryTargets({ originId: "x", coordinatorId: "x" }), [
    { id: "x", via: "origin" },
  ]);
});

test("配送: 投函元も総司令塔も無ければ空(呼ぶ側はカードを閉じない)", () => {
  assert.deepEqual(deliveryTargets({ originId: null, coordinatorId: null }), []);
  assert.deepEqual(deliveryTargets({ originId: "  ", coordinatorId: "" }), []);
});

test("配送: 投函元へ届いたら総司令塔へは送らない", async () => {
  const tried: string[] = [];
  const targets = deliveryTargets({ originId: "o", coordinatorId: "c" });
  const out = await attemptDelivery(targets, async (t) => {
    tried.push(t.id);
  });
  assert.equal(out.delivered?.id, "o");
  assert.deepEqual(tried, ["o"]);
});

test("配送: 投函元が閉じていて送れない→総司令塔へ届く", async () => {
  const targets = deliveryTargets({ originId: "o", coordinatorId: "c" });
  const out = await attemptDelivery(targets, async (t) => {
    if (t.id === "o") throw new Error("archived");
  });
  assert.equal(out.delivered?.id, "c");
  assert.equal(out.delivered?.via, "coordinator");
  assert.equal(out.errors.length, 1);
});

test("配送: どこにも届かなければ delivered は null(カードは閉じない)", async () => {
  const targets = deliveryTargets({ originId: "o", coordinatorId: "c" });
  const out = await attemptDelivery(targets, async () => {
    throw new Error("send failed");
  });
  assert.equal(out.delivered, null);
  assert.equal(out.errors.length, 2);
});

test("配送: 候補が空なら試さずに null", async () => {
  let calls = 0;
  const out = await attemptDelivery([], async () => {
    calls += 1;
  });
  assert.equal(out.delivered, null);
  assert.equal(calls, 0);
});

// 画像コメントも受け箱へ溜める(2026-11-08 ユーザー指示)が、5分待つと損をする報告だけは即時に送る。
test("すぐ届けるべき語: 故障・本番入れ替えなどは即時", () => {
  assert.equal(isUrgentCardChat("写真の1枚目、ボタンが動かない"), true);
  assert.equal(isUrgentCardChat("本番入れ替えの手順を先に決めたい"), true);
  assert.equal(isUrgentCardChat("データ消失の恐れがある"), true);
  assert.equal(isUrgentCardChat("ここは異常に見える"), true);
});

test("すぐ届けるべき語: ふつうの見た目の指摘は溜めてよい(即時にしない)", () => {
  assert.equal(isUrgentCardChat("余白が広すぎる"), false);
  assert.equal(isUrgentCardChat("文字が小さいので大きくしてほしい"), false);
  assert.equal(isUrgentCardChat(""), false);
});

test("即時判定の語に『確認箱』『判断待ち』を入れない(カードの見出しで必ず当たってしまう)", () => {
  assert.equal(isUrgentCardChat("確認箱の見た目について"), false);
  assert.equal(isUrgentCardChat("判断待ちの表示が変"), false);
  const marks: readonly string[] = URGENT_CARD_CHAT_MARKERS;
  assert.equal(
    marks.some((m) => m === "確認箱" || m === "判断待ち"),
    false,
  );
});
