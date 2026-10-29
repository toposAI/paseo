# チャット欄の画像表示(サーバー代理取得)設計メモ — 2026-10-29

ユーザー依頼(逐語): 「toposに画像出すようにしたけど、paseoも同様にして」
本命の意図(裏方2経由のユーザー回答): 「新しい物買う壁打ちとかのチャット欄に画像を出してほしい。toposでチャット欄に画像出すの実装したはずだから同様にして」＋「外部の画像をそのまま読み込ませず、サーバーが取ってきて渡す形」「読める場所と大きさに上限」。

参考(Topos): `0e50abb` / `fcc5628` の `backend/services/web_images.py`。https のみ・net_guard でプライベートIP拒否・5MB・形式は先頭バイト検査・robots尊重・表示時に取得してキャッシュ。

## 方針

アシスタント本文の `![alt](https://…)` を、端末(ブラウザ/アプリ)に外部サイトへ取りに行かせず、**デーモンが代理で取得**して、既存の「ローカル画像を表示する道」に合流させる。

既存の道(調査済み):

- 本文の画像は `message.tsx` の独自 image ルール → `AssistantMarkdownImage` → `resolveAssistantImageSource`(`packages/app/src/utils/assistant-image-source.ts`)。
- `file://` は `AssistantImageAcquisitionPort.readFile(cwd,path)` → デーモンへ `file_explorer_request` → バイト列 → `persist` → 環境ごとの preview URL(Web=blob / native=file://)。
- したがって、**代理取得したバイト列をこの `persist` に流せば、画面側の表示・拡大・キャッシュは既存のまま動く**。

## 変更点

1. `packages/protocol/src/messages.ts`
   - `ChatImageRequestSchema = {type:"chat_image_request", url, requestId}`
   - `ChatImageResponseSchema = {type:"chat_image_response", payload:{requestId, url, status:"ok"|"direct"|"error", data?:string(base64), mimeType?:string, reason?:string}}`
   - 要求・応答の union へ登録し、`messages.test.ts` に1件ずつ追加。

2. `packages/server/src/server/chat-images/remote-image.ts`(新規)
   - `fetchRemoteImage(url)` → `{status:"ok", bytes, mimeType}` | `{status:"direct", reason}` | `{status:"error", reason}`
   - 画面で読んでよい場所の上限 = この関数だけが外部へ出る。Vault やホームのパスには触れない。
   - https のみ。`PASEO_CHAT_IMAGES=off` なら `direct`(代理しない)。クライアントはこれを表示不可として扱う
     (端末が外部URLを取りに行く道は塞いである)。戻すときは旧ビルドへ戻す。
   - ホスト名は DNS で全アドレス解決し、プライベート/ループバック/リンクローカル/ULA/CGNAT/`::ffff:` マップを拒否。
   - **検査したアドレスへ実際に接続する**(`createPinnedLookup` + `createPinnedFetch`): 取得1回につき解決器は1つで、
     ホストの検査と接続は同じ答えを使う(同名ホストはリダイレクトをまたいでも1回だけ引く。答えはその取得の間だけ保持)。
     公共アドレス以外が混ざる・空・解決できない場合は接続前に拒否し、接続は検査したアドレスへ `node:https` の
     `lookup` 差し替えで行う(SNI/Host は元のホスト名のまま)。再接続の使い回し(`agent:false`)もしない。
   - 時間の上限は**取得1回で10秒**。DNS・全リダイレクト・本文の読み取りを1つの `AbortSignal` で縛る。
     リダイレクトは `redirect:"manual"` で最大3回(各ホップを同じ解決器で再検査)。
   - 受け取る形式は4種のみを明示(`accept: image/webp,image/jpeg,image/png,image/gif`)。CDN が AVIF を返して
     表示できない事故を避けるため。
   - 失敗の分類: **`direct` を返すのは代理が無効(`PASEO_CHAT_IMAGES=off`)のときだけ**。接続不能・時間切れは
     `error`(`reason:"unreachable"`)、検査で拒否は `error`(理由つき)。`direct` は「端末が直接取ってよい」の
     意味ではなく、クライアントは表示不可として扱う。
   - 連射の上限(12件/10秒)は**キャッシュに当たった分を数えない**(履歴の画像を開き直して13枚目以降が
     エラーになる事故を防ぐ)。
   - `accept: image/*`、UA は一般的なブラウザ相当。本文はストリームで読み **5MB を超えたら中断**。
   - Content-Type は png/jpeg/webp/gif のみ + **先頭バイトで再検査**(宣言だけ信じない)。
   - キャッシュ: `$PASEO_HOME/chat-images/<sha256(url)>.<ext>` + 同名 `.json`(url,mime,size,fetchedAt)。30日で失効。書込時に最大50件へ剪定。ワークスペース外に置く。

3. `packages/server/src/server/session.ts`
   - `case "chat_image_request"` を追加し、応答を要求元へ返す(`file_explorer_request` と同じ source 指定)。
   - 連射の上限: 直近10秒で12件を超えたら `error`(`reason:"rate_limited"`)。ハンドラ(`remote-image.ts`)が
     持つ(セッション破棄で消える。開いた資源は無いので後始末は要らない)。

4. クライアント
   - `assistant-image-source.ts`: `^https?://` → `{kind:"remote", url}`。
   - `assistant-image/file-acquisition.ts`: `kind:"remote"` 用の取得を追加(鍵は url)。
     - `ok` → 既存の `persist` に流す。
     - `direct`(代理無効・到達不可)/`error`(上限・拒否)/要求自体の失敗/未接続 → **すべて表示不可**
       (`unavailableMessage`)。端末が外部URLを直接読みに行く道は残さない(2026-10-29 変更)。
       古いデーモンに繋いだ場合も画像は出ないが、端末の外部アクセスは起きない。
   - `use-assistant-image.ts`: port に `fetchChatImage` を足して配線。
   - `packages/client/src/daemon-client.ts`: `fetchChatImage(url)` を `requestFileExplorer` と同じ形で追加。

5. AI側の出し方(別リポジトリ)
   - `.claude/skills/buy-research/SKILL.md` Step 3.5: 候補提示の時点で `![商品名](https://…)` を本文に書く。**1回の返答で最大4枚**、最大サイズのURL、`https` のみ、裸のURLを並べない。

## 上限のまとめ

- 通信: https のみ / タイムアウト10秒 / リダイレクト3回 / 5MB / png・jpeg・webp・gif。
- 枚数: 返答あたり4枚(出し方の決まり)＋ サーバー側の連射上限12件/10秒。
- 場所: 外部URLのみ。ローカルの任意パスは読まない。

## 確認箱(案C)の上限

- 投函: 最大4枚・1枚2MiB(base64)・png/jpeg/webp/gif。上限は `notify_box.normalize_images()`(Python)と
  `box.ts imagesField()`(プラグイン)の2か所にある。**揃えるのはテストではなく運用**(同じ値を両方に書いている)。
- 一覧(`GET /items`)は画像の中身を返さず `imageCount` だけ返し、ページは `/items/<id>/image/<n>` から読む
  (15秒ごとの再取得で数MBを運ばないため)。同じ origin なので端末は外部へ出ない。
- 不正な1枚は落として残りを表示する(項目ごと失敗させない)。

## やらないこと(今回の範囲外)

- 画像の内容判定(不適切画像の除外)。取得元URLはAIが選ぶ。
- 確認箱の項目本文のMarkdown化(案Cは画像フィールドの追加と表示のみ)。

## 案A: 窓口Bへの依頼に付いた画像を窓口へ画像として渡す(2026-10-29)

- 窓口B(`window_b_request.py`)が受け取る添付は `ATTACH_DIR` 配下の写しだけを読む(任意のホーム/リポジトリのパスは読まない)。
- 写しは本文に `![](…)` かファイル一覧として載せ、窓口(受け取った側のスレ)はその画像を `Read` して内容を確認できる。
  家族の写真なので、画像のパス・中身をログやVault、子スレへ渡さない(窓口Bのコピーは子スレに渡さない)。

## 案C: 確認箱の項目に画像を出す(2026-10-29)

- プロトコル: `ConfirmBoxItemSchema.images = [{data: base64, mimeType: "image/png"|"image/jpeg"|"image/webp"|"image/gif"}]`(任意)。
- プラグイン `topos-confirm-box` は **最大4枚・1枚2MiB**、形式は宣言と先頭バイトの両方を検査し、不正な1枚だけを落とす。
  画面は 96×96 の data URI サムネイル(端末は外部へ取りに行かない)。
- 投函側(ToposAI): `scripts/confirm_box_deposit.py --image <画像ファイル>`(推奨)/ `notify_box.py` の `images`。

## 残っている制約(既知)

- 画像の内容判定はしない。取得元URLはAIが選ぶ。失敗した画像は本文にalt文として残る(`Image preview unavailable.`)。
- 極端に縦横の大きい画像(5MiB以内でも展開すると重い)は検査していない。
- 同じURLの同時取得を1本にまとめていない(同時実行数の全体上限も無い)。
- キャッシュのメタデータ(`.json`)に取得元URLを平文で残す(署名付きURLのクエリも含む)。
- Topos の `web_images.py` が持つ robots.txt の尊重は無い(チャット本文の画像1枚を取るだけで、巡回はしない)。
- キャッシュ書込・読込の失敗は黙って握りつぶす(ディスク満杯でも気づかず毎回取り直す)。
- 到達不能(`unreachable`)は誤って「表示不可」で固定されうる(取得結果は成功分だけキャッシュするので、次の描画時に再試行)。
