# 確認箱 下部タブ 5枚化 — 設計(2026-10-22)

既存2枚(判断待ち `items` / 優先順位 `priority`)に3枚を足す。**1画面ずつ、データ元・表示項目・バッジを先に固定する**。

底部は**アイコンのみ**の5等分。iPhone幅390pxで 390/5 = 78px/枚、最小56pxを割る幅では横スクロールへ落ちる
(`flexGrow:1` + `minWidth:56`)。「その他」に畳む案は採らない(5枚なら等分で収まり、畳むと1タップ増える)。

## 1. 判断待ち(既存・変更なし)

- データ元: `~/.local/state/toposai/confirm_box/events-*.jsonl` の箱 + `pending_user_decisions.jsonl` の未投函 + Paseo の承認待ち。
- バッジ: `options` を持つ項目のうち未承認の件数(`confirmBoxCountRpc.open`、従来どおり)。

## 2. Toposバグ報告(bug)

- データ元: 家族版/試用版が1件1JSONで書く報告ファイル `<data_dir>/_feedback/reports/fb-*.json`。
  既定は `/Users/user/topos-family/data/_feedback` と `/Users/user/topos-trial/data/_feedback`
  (`TOPOS_FEEDBACK_DIRS` で上書き可、`:` 区切り)。読むだけ。バックアップ配下は見ない。
- 表示項目: 題名 / 種別(バグ・要望)/ 報告者表示名 / 受付日時 / 状態 / 緊急フラグ / スクリーンショット有無。
  展開すると本文・返信・画面名・アプリ版。
- 報告者名: `~/.local/state/toposai/confirm_box/reporter_labels.json`(id→呼び名)→
  `topos-users.yaml` の `display_name` → 生の id の順で解決。
- バッジ: `status === "new"` の件数(=未対応の新着報告)。
- 見るだけの画面。判断は確認箱の「判断待ち」側で行う(重複実装しない)。

## 3. 子スレ完了報告(childdone)

- データ元: **既存の** `child_threads.json` と `childThreadsListRpc`。`status === "完了"` かつ未アーカイブだけ出す。
  完了まとめ本文は箱の項目(`summaryItemId` 一致)から引く — 既存機構をそのまま使う。
- 表示項目: 題名 / 親(子司令塔)/ 完了日時 / まとめ本文(結論の数行)。展開で全文。
- 操作: 「確認してアーカイブ」= まとめ項目を `ack(approve)`。アーカイブ自体は既存の
  `child_thread_registry.py tick`(4分毎)が ack 済みの完了スレを `paseo agent archive` する。**新しい削除経路を作らない**。
- バッジ: 完了かつまとめ未確認(`summaryState` が read/approved でない)の件数。

## 4. 通知(notify)

- データ元: 確認箱の箱項目のうち **`options` が空のもの**(=判断を伴わないお知らせ)。実行時に追加コストなし。
- 除外: `source === "topos_feedback"`(家族報告の新着通知。タブ2と重複)と
  `source === "child_thread_report"`(完了まとめ。タブ3と重複)。
- 表示項目: 題名 / 出所(source)/ 日時。展開で本文・背景。
- 操作: 個別「既読」と「すべて既読」。既読は箱の `ack` イベント(`{"t":"ack","id","ts","action":"read"}`)を
  追記する — Paseo 本体ストア `store.ts` と同じ契約。
- バッジ: 未読(`state === "new"`)件数。

## 5. 優先順位(既存・変更なし)

## 判断が割れた点(ユーザー確認待ち)

1. **通知の初回既読**: 箱の ack はこれまで1件も書かれていないため、いま通知タブを開くと過去3日分(約125件)が
   全部未読で、バッジが「99+」になる。初回だけ「全部既読」を押す運用でよいか、
   それともバッジを直近24時間に限定するか。
2. **通知の範囲**: 上記のとおり家族報告の新着通知(`topos_feedback`)はタブ2へ寄せて通知から外した。
   監視系ウォッチドッグのお知らせだけが通知に残る。この切り分けでよいか。
3. **アーカイブの反映待ち**: 「確認してアーカイブ」は ack を書くだけで、実際のアーカイブは最大4分後の tick。
   即時に消したい場合はプラグインから `paseo agent archive` を呼ぶ経路が要る(削除経路が増えるので既定では採らない)。

## 追加する RPC

- `topos.feedback.reports.list` … 報告ファイルの読み取り
- `topos.confirmbox.ack` / `topos.confirmbox.ackall` … 既読・確認の追記(箱の契約どおり)
- `confirmBoxCountRpc` の出力に `notifications` / `bugs` / `childDone` を追加(バッジ用)
