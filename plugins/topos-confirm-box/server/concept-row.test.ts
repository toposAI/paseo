import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROW_TITLE_MAX,
  conceptRowFullLabel,
  conceptRowTitle,
  conceptSections,
  collapseRepeatedTitle,
  conceptThreadBadge,
  conceptThreadBadgeLabel,
  deferMenuLabel,
  laterSectionLabel,
  shorten,
} from "../shared/concept-row.js";

test("shorten: 空白を潰し、上限を超えたら…を付ける(上限ちょうどは付けない)", () => {
  assert.equal(shorten("  あ  い \n う ", 10), "あ い う");
  assert.equal(shorten("あいうえお", 5), "あいうえお");
  assert.equal(shorten("あいうえおか", 5), "あいうえ…");
  assert.equal(shorten("あいう", 0), "");
});

test("shorten: 絵文字を半分にしない(コードポイント単位)", () => {
  assert.equal(shorten("🧪🧪🧪", 3), "🧪🧪🧪");
  assert.equal(shorten("🧪🧪🧪🧪", 3), "🧪🧪…");
});

test("conceptRowTitle: 長い題名は1行の上限に収まる", () => {
  const long = "とても長い題名の構想ノートを1行に収めるための確認用の題名です";
  const t = conceptRowTitle({ title: long });
  assert.ok(Array.from(t).length <= ROW_TITLE_MAX);
  assert.ok(t.endsWith("…"));
  // 短い題名はそのまま
  assert.equal(
    conceptRowTitle({ title: "製品版のシークレットモード" }),
    "製品版のシークレットモード",
  );
});

test("conceptThreadBadge: スレあり/未解決/未作成を分ける", () => {
  assert.equal(conceptThreadBadge({ threadId: "t-1", threadCandidates: ["t-1"] }), "thread");
  assert.equal(conceptThreadBadge({ threadId: null, threadCandidates: ["c389e3e"] }), "unresolved");
  assert.equal(conceptThreadBadge({ threadId: null, threadCandidates: [] }), "none");
});

test("アイコンの説明は3種で言い分ける(「構想」の文字は使わない)", () => {
  const labels = (["thread", "unresolved", "none"] as const).map((b) => conceptThreadBadgeLabel(b));
  assert.equal(new Set(labels).size, 3);
  for (const l of labels) assert.ok(!l.startsWith("構想"));
});

test("印の読み上げは押した結果だけを言う(行をタップした結果と混ぜない)", () => {
  const press = conceptThreadBadgeLabel("none", "press");
  assert.ok(press.includes("印を押すと説明が出ます"));
  assert.ok(!press.includes("行をタップ"));
  // 押した後に出る説明は、行を押すと何が起きるかまで言う
  assert.ok(conceptThreadBadgeLabel("none", "notice").includes("行をタップ"));
});

test("押した後に出る説明は3種で言い分ける(どれも行の動作を言う)", () => {
  const labels = (["thread", "unresolved", "none"] as const).map((b) =>
    conceptThreadBadgeLabel(b, "notice"),
  );
  assert.equal(new Set(labels).size, 3);
  for (const l of labels) assert.ok(l.includes("行をタップ"));
});

test("collapseRepeatedTitle: `__` で二重に書かれた題名は片方へ畳む", () => {
  assert.equal(collapseRepeatedTitle("A__A"), "A");
  assert.equal(collapseRepeatedTitle("A__ a "), "A");
  assert.equal(collapseRepeatedTitle("A__B"), "A__B");
  assert.equal(collapseRepeatedTitle("__A"), "__A");
  assert.equal(
    conceptRowTitle({ title: "1ノート1機能のtoposツール構想__1ノート1機能のtoposツール構想" }),
    "1ノート1機能のtoposツール構想",
  );
});

test("あとでの見出しは件数だけを出す(0件も文言で分かる)", () => {
  assert.equal(laterSectionLabel(0), "あとで(なし)");
  assert.equal(laterSectionLabel(3), "あとで 3件");
});

test("行メニューの文言は区分の向きで変わる", () => {
  assert.equal(deferMenuLabel("active"), "あとで(今は見ない)");
  assert.equal(deferMenuLabel("later"), "検討中に戻す");
});

test("conceptSections: 旧置き場では見出しを出さない", () => {
  assert.deepEqual(conceptSections("legacy", { later: 0, laterAvailable: false }), {
    showLater: false,
    laterToggle: false,
  });
});

test("conceptSections: 旧置き場でも「あとで」にノートがあれば見出しは出す(見えなくしない)", () => {
  assert.deepEqual(conceptSections("legacy", { later: 2, laterAvailable: false }), {
    showLater: true,
    laterToggle: false,
  });
});

test("conceptSections: 新置き場では件数0でも見出しを出す(片方だけの移行中も消さない)", () => {
  assert.deepEqual(conceptSections("paseo", { later: 0, laterAvailable: true }), {
    showLater: true,
    laterToggle: true,
  });
  // 「あとで」だけ在る(移行の途中): 見出しは出すが、押して開けるのは両方あるときだけ
  assert.deepEqual(conceptSections("paseo", { later: 2, laterAvailable: false }), {
    showLater: true,
    laterToggle: false,
  });
});

test("conceptRowFullLabel: 長押し/読み上げ用の全文(題名は切らない)", () => {
  const long = "1ノート1機能のtoposツール構想__1ノート1機能のToposツール構想";
  assert.equal(conceptRowFullLabel({ title: long, conclusion: "作りたい" }), `${long} — 作りたい`);
});
