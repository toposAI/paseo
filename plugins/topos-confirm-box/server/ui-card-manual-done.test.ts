import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 2026-11-08 ユーザー逐語:
// 「UI確認の確認箱、画像ごとにコメントするから、1枚の画像にコメントした直後にその確認箱終了にするのやめて、
//   僕が全部の画像を確認した後に僕が手動で完了ボタンを押します。」
// 画像へのコメントはカードを閉じる合図ではない。閉じるのはカードの「完了」ボタンだけ。

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
const read = (name: string) => readFileSync(path.join(clientDir, name), "utf8");

function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} が見つからない`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} が見つからない`);
  return source.slice(start, end);
}

test("画像コメントではカードを閉じる処理を呼ばない(closeAfterComment は残っていない)", () => {
  const view = read("ConfirmBoxView.tsx");
  // 拡大表示に渡す設定に onDone を載せない(載せると押した先でカードが閉じる経路が復活する)。
  const lightbox = block(view, "const lightboxComment = useMemo(", "const reject = useCallback");
  assert.doesNotMatch(lightbox, /\bonDone\b/, "拡大表示のコメント欄に onDone を渡さない");
  assert.doesNotMatch(view, /closeAfterComment/, "誰も呼ばない閉じ処理を残さない");
});

test("画像コメントの送信では次へ進めない(カードを畳まない)", () => {
  // onSent を呼ぶと useUfcFlow.afterSent が current を次のカードへ移し、そのカードは畳まれる。
  const pane = read("CardChatPane.tsx");
  assert.match(
    pane,
    /if \(ok && !imageComment\) onSent\?\.\(\);/,
    "画像コメントでは onSent を呼ばない",
  );
  assert.doesNotMatch(pane, /^\s*if \(ok\) onSent\?\.\(\);/m, "無条件の onSent を残さない");
});

test("ImageCommentDock に『このカードを完了』ボタンが無い", () => {
  const dock = read("ImageCommentDock.tsx");
  assert.doesNotMatch(dock, /このカードを完了/, "画像コメント欄から完了にしない");
  assert.doesNotMatch(dock, /\bonDone\b/, "onDone を受け取らない");
});

test("画像ビューアに onDone の受け渡しが残っていない", () => {
  assert.doesNotMatch(read("ImageLightbox.tsx"), /\bonDone\b/);
  // カード自体の「完了」ボタン用の onDone は残る。画像ビューア(ImageViewer)の中だけ見る。
  const card = read("UiFinalCheckCard.tsx");
  const viewer = block(card, "function ImageViewer(", "const STATUS_TEXT");
  assert.doesNotMatch(viewer, /\bonDone\b/);
});

test("カードの『完了』ボタンは残っている", () => {
  const card = read("UiFinalCheckCard.tsx");
  assert.match(card, /const done = useCallback/, "完了ボタンの処理がある");
  assert.match(card, /onPress=\{done\}/, "完了ボタンが押せる");
});
