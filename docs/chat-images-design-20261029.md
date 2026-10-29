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
   - https のみ。`PASEO_CHAT_IMAGES=off` なら `direct`(クライアントは従来どおり直接表示=戻し道)。
   - ホスト名は DNS で全アドレス解決し、プライベート/ループバック/リンクローカル/ULA/CGNAT/`::ffff:` マップを拒否。
   - `fetch` は `AbortSignal.timeout(10_000)`、`redirect:"manual"` で最大3回(各ホップを再検査)。
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
     - `direct` → そのまま `{uri:url}` で直接表示(従来動作)。
     - `error` → 取得失敗として扱い、既存の `unavailableMessage` 表示に落とす。
     - デーモンが新しい要求を知らない/失敗する場合も `direct` に倒す(古いデーモンとの互換)。
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
