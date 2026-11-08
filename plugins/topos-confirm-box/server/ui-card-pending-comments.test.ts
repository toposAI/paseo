import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 出口レビュー指摘(中4・中5・中6):
// - OK / 次へ でカードを離れるときも、溜めた画像コメントを捨てずに先に1回まとめて送る
// - 送れない環境で「完了」が永久に失敗して閉じられなくならないよう、失敗時だけ逃げ道を出す
// - カードがアンマウントされても溜めを失わないよう、溜めはモジュールスコープの Map に置く
//
// 実行時に React を動かす基盤が無いので、既存の ui-card-manual-done.test.ts と同じソース検査で確かめる。

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
const read = (name: string) => readFileSync(path.join(clientDir, name), "utf8");

function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} が見つからない`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} が見つからない`);
  return source.slice(start, end);
}

function assertFlushesFirst(handler: string, after: string): void {
  const flush = handler.indexOf("flushPending()");
  assert.ok(flush >= 0, "共通の送信関数 flushPending を通っていない");
  const proceed = handler.indexOf(after);
  assert.ok(proceed >= 0, `${after} が見つからない`);
  assert.ok(flush < proceed, `${after} より前にまとめ送信を行う(溜めを取りこぼさない)`);
  assert.match(
    handler,
    /if \(!\(await flushPending\(\)\)\) return;/,
    "送れなければ元の動作をせず止める",
  );
}

test("OK は溜めた画像コメントを先に送り、成功してから OK にする", () => {
  const card = read("UiFinalCheckCard.tsx");
  const handler = block(card, "const ok = useCallback(", "const next = useCallback");
  assertFlushesFirst(handler, "onChoose(");
  assert.match(card, /onPress=\{ok\}/, "OKボタンがこの処理を呼ぶ");
});

test("次へ も溜めた画像コメントを先に送り、成功してから次へ進む", () => {
  const card = read("UiFinalCheckCard.tsx");
  const handler = block(card, "const next = useCallback(", "const discardAndDone = useCallback");
  assertFlushesFirst(handler, "onSkip(");
  assert.match(card, /onPress=\{next\}/, "次へボタンがこの処理を呼ぶ");
});

test("送れないときだけ「コメントを送らずに完了」の逃げ道を出し、押すと onDone で閉じる", () => {
  const card = read("UiFinalCheckCard.tsx");
  const label = card.indexOf("コメントを送らずに完了");
  assert.ok(label >= 0, "逃げ道のボタンが無い");
  // 普段は見せない: ボタンは flushFailed の条件の中だけに出す。
  const before = card.slice(Math.max(0, label - 400), label);
  assert.match(before, /flushFailed \? \(/, "失敗したときだけ出す(普段は見せない)");
  assert.match(
    card,
    /onDiscard=\{discardAndDone\}|onPress=\{discardAndDone\}/,
    "逃げ道のボタンが捨てて閉じる処理を呼ぶ",
  );
  const handler = block(card, "const discardAndDone = useCallback(", "const header = useCallback");
  assert.match(handler, /clearPending\(item\.id\)/, "押したら溜めを消す");
  assert.match(handler, /onDone\(item\)/, "押したらカードを閉じる");
});

test("溜めた画像コメントはコンポーネントの外の Map に置き、マウント時に読み戻す", () => {
  const card = read("UiFinalCheckCard.tsx");
  const mapAt = card.indexOf("const pendingByItem = new Map");
  const componentAt = card.indexOf("export function UiFinalCheckCard(");
  assert.ok(mapAt >= 0, "モジュールスコープの Map が無い(アンマウントで溜めが消える)");
  assert.ok(componentAt > mapAt, "Map はコンポーネントの外に置く");
  assert.match(
    card,
    /^const pendingByItem = new Map<string, string\[\]>\(\);$/m,
    "キーは item.id の string[]",
  );
  assert.match(
    card,
    /useState\(\(\) => pendingOf\(item\.id\)\.length\)/,
    "マウント時に件数を読み戻す(カードを離れて戻ると『コメント{n}件をまとめて送ります』が出る)",
  );
  // カードの中に閉じた溜め(アンマウントで消える)を残さない。
  assert.doesNotMatch(card, /pendingRef/, "コンポーネント内の溜めを残さない");
});
