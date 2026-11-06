/**
 * 窓口Bの「指示の一覧」の表示の決まり。取れなかったときに前回の一覧を残すこと・並び・
 * 開く場所だけを見る(状態の判断は Python 側)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WindowBInstructionsOutput } from "../shared/contract.js";
import {
  STALE_AFTER_MS,
  WIDE_MIN_WIDTH,
  doneButtonText,
  emptyText,
  filterByMode,
  freshnessNote,
  keepLastOnFailure,
  noticeLines,
  paneLocation,
  plainAssignee,
  rowOrder,
  routeText,
  visibleRoutes,
  rowTitle,
  type InstructionRoute,
  staleNotice,
  summarize,
  summarizeExtras,
  truncationNote,
} from "../shared/windowb-instructions.js";

function out(total: number, alerts = 0, warns = 0): WindowBInstructionsOutput {
  return {
    generatedAt: 0,
    ledgerUpdatedAt: 0,
    total,
    items: [],
    counts: {},
    alerts,
    warns,
    notices: [],
  };
}

test("失敗したら前回の一覧を残し、知らせだけ出す(空にしない)", () => {
  const prev = out(3);
  const failed = keepLastOnFailure(prev, { ok: false, error: "timeout" });
  assert.equal(failed.data, prev);
  assert.equal(failed.error, "timeout");
  // 一度も取れていなければ null(= 空ではなく「取れない」)
  assert.deepEqual(keepLastOnFailure(null, { ok: false, error: "x" }), { data: null, error: "x" });
  // 成功したら差し替えて知らせを消す
  const next = out(4);
  assert.deepEqual(keepLastOnFailure(prev, { ok: true, data: next }), { data: next, error: null });
});

test("要約は件数と赤・未登録だけを短く出す", () => {
  assert.equal(summarize(null), "読み込めていません");
  assert.equal(summarize(out(2)), "2件");
  assert.equal(summarize(out(5, 2, 1)), "5件 / 赤 2 / 未登録 1");
});

test("並びは 赤 → 判断待ち → 届いたか不明/返事なし → 橙 → その他 → 完了。同じ群は元の順", () => {
  const rows = [
    { key: "done", alert: null, warn: null, kind: "完了" },
    { key: "working", alert: null, warn: null, kind: "作業中" },
    { key: "x", alert: "no_reply", warn: null, kind: "作業中" },
    { key: "wait", alert: null, warn: null, kind: "判断待ち(確認箱)" },
    { key: "y", alert: "unassigned", warn: null, kind: "受付済み" },
    { key: "unl", alert: null, warn: "unledgered", kind: "未登録" },
    { key: "unknown", alert: null, warn: null, kind: "届いたか不明" },
    { key: "working2", alert: null, warn: null, kind: "作業中" },
  ];
  assert.deepEqual(
    rowOrder(rows).map((r) => r.key),
    ["x", "y", "wait", "unknown", "unl", "working", "working2", "done"],
  );
});

test("上限で切ったときは何件出しているかを言う(切ったと分からないと赤が無いと読み違える)", () => {
  assert.equal(truncationNote({ ...out(3), items: [{}, {}, {}] as never }), null);
  assert.equal(
    truncationNote({ ...out(60), items: Array.from({ length: 40 }, () => ({})) as never }),
    "全60件中 上位40件を表示",
  );
});

test("PC幅の見出しは帯と重ならないよう未登録だけを出す", () => {
  assert.equal(summarizeExtras(null), null);
  assert.equal(summarizeExtras(out(5)), null);
  assert.equal(summarizeExtras(out(5, 2, 1)), "未登録 1");
});

test("台帳の更新が止まったときだけ知らせる(新しいうちは何も出さない)", () => {
  const t = new Date(2026, 9, 30, 10, 5).getTime();
  const ledger = t - 60_000;
  const data = { ...out(1), generatedAt: t, ledgerUpdatedAt: ledger };
  assert.equal(freshnessNote(data, t), null);
  // 15分の手前までは何も出さず、ちょうど15分から知らせる
  assert.equal(freshnessNote(data, ledger + STALE_AFTER_MS - 1), null);
  assert.equal(freshnessNote(data, ledger + STALE_AFTER_MS), "台帳が 10:04 から更新されていません");
  assert.equal(
    freshnessNote({ ...data, ledgerUpdatedAt: 0 }, t),
    "台帳の更新時刻がまだありません(状態が古いかもしれません)",
  );
});

test("PC幅は右カラム、狭い画面は主ペイン(全画面)", () => {
  assert.equal(paneLocation(WIDE_MIN_WIDTH), "right");
  assert.equal(paneLocation(1440), "right");
  assert.equal(paneLocation(WIDE_MIN_WIDTH - 1), "workspace");
  // iPhone の幅
  assert.equal(paneLocation(390), "workspace");
});

test("15分以上前の読み出しは「古い表示(時刻)」として目立たせる", () => {
  const t = new Date(2026, 9, 30, 9, 41).getTime();
  const data = { ...out(1), generatedAt: t };
  // ちょうど15分は古い扱い(「より古い」ではなく「15分たったら」)
  assert.equal(staleNotice(data, t + STALE_AFTER_MS), "古い表示(09:41時点)");
  // 14分59秒はまだ新しい
  assert.equal(staleNotice(data, t + STALE_AFTER_MS - 1), null);
  // 読み出しが0(=一度も取れていない)は古い扱い
  assert.equal(staleNotice({ ...out(1), generatedAt: 0 }, t) !== null, true);
});

test("filterByMode: 完了報告待ちは完了ではないので、どちらの見せ方でも隠さない", () => {
  const rows = [{ kind: "完了報告待ち" }, { kind: "完了" }, { kind: "作業中" }];
  assert.deepEqual(
    filterByMode(rows, "active").map((r) => r.kind),
    ["完了報告待ち", "作業中"],
  );
  assert.deepEqual(
    filterByMode(rows, "done").map((r) => r.kind),
    ["完了報告待ち", "完了"],
  );
});

test("filterByMode: 既定は完了を隠し、done は完了だけ", () => {
  const rows = [{ kind: "作業中" }, { kind: "完了" }, { kind: "返事なし" }, { kind: "完了" }];
  assert.deepEqual(
    filterByMode(rows, "active").map((r) => r.kind),
    ["作業中", "返事なし"],
  );
  assert.deepEqual(
    filterByMode(rows, "done").map((r) => r.kind),
    ["完了", "完了"],
  );
  // 完了だけ の間も、判断待ち・赤・橙は隠さない
  const att = [
    { kind: "完了" },
    { kind: "判断待ち(確認箱)" },
    { kind: "作業中", alert: "no_reply" },
    { kind: "作業中", warn: "unposted" },
    { kind: "作業中" },
  ];
  assert.equal(filterByMode(att, "done").length, 4);
  assert.equal(doneButtonText("active", 3), "完了だけ(3)");
  assert.equal(doneButtonText("done", 3), "一覧にもどる");
  assert.notEqual(emptyText("active"), emptyText("done"));
});

const route = (over: Partial<InstructionRoute>): InstructionRoute => ({
  no: 1,
  summary: "画像を出す",
  dest: "子スレ",
  assignee: "実装スレ",
  childStatus: "実装中",
  status: "割当済",
  done: false,
  ...over,
});

test("routeText: 子スレは題名と自己申告の状態、完了は「完了」、登録簿に居なければ状態不明", () => {
  assert.equal(routeText(route({})), "1. 画像を出す ・ 子スレ「実装スレ」 ・ 実装中");
  assert.equal(
    routeText(route({ done: true, status: "完了" })),
    "1. 画像を出す ・ 子スレ「実装スレ」 ・ 完了",
  );
  assert.equal(
    routeText(route({ childStatus: null })),
    "1. 画像を出す ・ 子スレ「実装スレ」 ・ 状態不明",
  );
});

test("routeText: 子スレ以外は理由を括弧で、種別が空なら「まだ振っていない」(台帳の状態を出す)", () => {
  assert.equal(
    routeText(
      route({
        dest: "説明のみ",
        assignee: "口頭で足りる",
        childStatus: null,
        status: "完了",
        done: true,
      }),
    ),
    "1. 画像を出す ・ 説明のみ(口頭で足りる) ・ 完了",
  );
  assert.equal(
    routeText(route({ dest: "", assignee: "", childStatus: null, status: "未割当" })),
    "1. 画像を出す ・ まだ振っていない ・ 未割当",
  );
});

test("visibleRoutes: 閉じている間は3項目まで、開くと全部。古いサーバ(routes なし)は空", () => {
  const rs = [1, 2, 3, 4, 5].map((no) => route({ no }));
  assert.deepEqual(visibleRoutes(rs, false).hidden, 2);
  assert.equal(visibleRoutes(rs, false).shown.length, 3);
  assert.equal(visibleRoutes(rs, true).shown.length, 5);
  assert.equal(visibleRoutes(rs.slice(0, 3), false).hidden, 0);
  assert.deepEqual(visibleRoutes(undefined, false), { shown: [], hidden: 0 });
});

test("rowTitle: 要約があればそれ、無ければ全文の1行目", () => {
  assert.equal(rowTitle({ title: "要約", text: "全文\n2行目" }), "要約");
  assert.equal(rowTitle({ title: " ", text: "\n全文1行目\n2行目" }), "全文1行目");
});

test("rowTitle: 内部ID風の整理番号と末尾の番号を落として平易にする", () => {
  assert.equal(rowTitle({ title: "140c完了の確認(#261)", text: "x" }), "完了の確認");
  assert.equal(
    rowTitle({ title: "5067返答:①の再デプロイを総司令塔へ", text: "x" }),
    "返答:①の再デプロイを総司令塔へ",
  );
  // 落とすと空になる題は消さない(意味のある語は残す)
  assert.equal(rowTitle({ title: "abc", text: "x" }), "abc");
  // リンクだけの題は、題として読める語に言い換える
  assert.equal(rowTitle({ title: "(リンク)", text: "https://example.com" }), "リンクの依頼");
});

test("plainAssignee: 英数のIDだけの担当は「担当のスレ」と言い換える", () => {
  assert.equal(plainAssignee("7ace1dd7"), "担当のスレ");
  assert.equal(plainAssignee("雑務係"), "雑務係");
  assert.equal(plainAssignee("  "), "担当未定");
});

test("noticeLines: 技術的な注意書きを短い行(最大2行)に直す", () => {
  const lines = noticeLines([
    "同じ鍵の依頼が 35件あり、1件にまとめて出しています",
    "日付の無い依頼 1件は日付を決められないので出していません",
    "日付の無い依頼 1件は下(後)の日付の印から日付を決めています",
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "同じ依頼35件は1つにまとめて表示");
  assert.equal(lines[1], "日付の分からない依頼1件は非表示 ほか1件");
  // 知らない文言は消さずにそのまま出す(黙って落とさない)
  assert.deepEqual(noticeLines(["知らない注意"]), ["知らない注意"]);
});

test("noticeLines: 切り詰めの注記と合わせて2行に収めるときは残り行数を渡す", () => {
  const notices = [
    "同じ鍵の依頼が 35件あり、1件にまとめて出しています",
    "日付の無い依頼 1件は日付を決められないので出していません",
    "日付の無い依頼 1件は下(後)の日付の印から日付を決めています",
  ];
  assert.deepEqual(noticeLines(notices, 1), ["同じ依頼35件は1つにまとめて表示 ほか2件"]);
  // 0 以下でも行は消さない(1行は必ず出す)
  assert.deepEqual(noticeLines(["知らない注意"], 0), ["知らない注意"]);
});
