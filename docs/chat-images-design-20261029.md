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
   - **検査したアドレスへ実際に接続する**(`createPinnedFetch`): 解決は1回だけ、公共アドレス以外が混ざれば拒否し、
     その同じアドレスへ `node:https` の `lookup` 差し替えで接続する(SNI/Host は元のホスト名のまま)。
     DNS 再解決によるすり替え(DNSリバインディング)の隙間を閉じるため。解決結果は成功分のみプロセス内で再利用し、失敗は捨てる。
   - タイムアウトは DNS 解決を含む10秒(`AbortSignal.timeout`)で、`redirect:"manual"` により最大3回(各ホップを再検査)。
   - `accept: image/*`、UA は一般的なブラウザ相当。本文はストリームで読み **5MB を超えたら中断**。
   - Content-Type は png/jpeg/webp/gif のみ + **先頭バイトで再検査**(宣言だけ信じない)。
   - キャッシュ: `$PASEO_HOME/chat-images/<sha256(url)>.<ext>` + 同名 `.json`(url,mime,size,fetchedAt)。30日で失効。書込時に最大50件へ剪定。ワークスペース外に置く。

3. `packages/server/src/server/session.ts`
   - `case "chat_image_request"` を追加し、応答を要求元へ返す(`file_explorer_request` と同じ source 指定)。
   - 連射の上限: 直近10秒で12件を超えたら `error`(`reason:"rate_limited"`)。

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
- 到達不能(`unreachable`)は誤って「表示不可」で固定されうる(取得結果は成功分だけキャッシュするので、次の描画時に再試行)。
