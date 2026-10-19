# topos-customizations ブランチについて

このリポジトリは upstream (`getpaseo/paseo`) の fork (`toposAI/paseo`)。
独自改造は `.patch` の都度当て直しではなく、このブランチにまとめて管理する。

- `origin` = このfork (`toposAI/paseo`)
- `upstream` = 本家 (`getpaseo/paseo`)
- 改造は全て `topos-customizations` ブランチに乗せる。`main` は upstream 追従専用で直接コミットしない。

## 上流追従手順

```
git checkout main
git fetch upstream
git merge --ff-only upstream/main   # mainはupstream追従専用なのでff-onlyで十分
git push origin main

git checkout topos-customizations
git rebase main
# コンフリクトが出たら解消してから:
git push --force-with-lease origin topos-customizations
```

## 現在乗っている改造

- `packages/app/src/composer/draft/workspace-tab.tsx`: `paddingBottom: isWeb ? 0 : insets.bottom`
  (mobile safe-area余白バグ対策として追加したが、実機で効果未確認。iOS Simulator整備後に要検証・要否判断)
- `packages/app/src/screens/workspace/workspace-screen.tsx`: `WorkspaceScreenContent`が自分の`serverId`に対し
  directory demandを取得するuseEffectを追加(`useHostRegistryLoaded()`依存でhost登録タイミングのレースにも対応)。
  モバイルでサイドバーを一度も開かずチャット画面を直接開くと`hasHydratedAgents`が永久falseに固着しChatが
  無限ローディングになる不具合の修正。iOS SimulatorでのコールドスタートA/Bで解消を確認、fable-review
  round3-4で収束(コミットc299486a6)。実機での確認はまだ。
- `packages/server/src/server/agent/providers/claude/agent.ts` の `claudeModeCatalog()`:
  既定 permission mode を upstream の `"auto"` から **`"bypassPermissions"`** へ変更(2026-10-02)。
  この fork の Claude 系プロバイダ(claude/deepseek/deepinfra/opencodego)は 147 gateway 経由で
  DeepSeek/DeepInfra/OpenCode Go を既定にするため、Anthropic API 前提の `auto`(model classifier)が
  使えないケースがあることが動機。呼び出し元が `allowDangerouslySkipPermissions: true` を常に渡すので
  SDK 側の前提は満たされる。critical path の `rm`/`rmdir` 回路ブレーカーと PreToolUse hook の `deny` は
  `bypassPermissions` でも有効(2026-10-01 実機実測)。`claudeAutoModeUnavailableOn` 側
  (Bedrock/Vertex)の分岐は upstream のまま `"default"` を残している。
  ※ アプリ側のピッカーは「その provider で最後に選んだ mode」(`providerPrefs.mode`)を
  provider 既定より優先するため、既に mode を選んだことのある環境では表示が変わらない場合がある。
- **スレッド途中でのプロバイダ切り替え**(2026-10-03)。従来 Paseo は「1 provider = 1 process」で、
  provider は起動時に spawn される env(`ANTHROPIC_BASE_URL` 等)に焼き込まれるため、スレッド途中で
  変更できなかった(provider は `SerializableConfig` にも存在しない)。OpenCode Go の枠が埋まった
  瞬間に同一スレッドのまま DeepSeek 本家へ移りたい、という運用要求のために以下を追加した:
  - `packages/protocol/src/messages.ts`: `set_agent_model_request` に任意の `provider` を追加。
    省略時=モデルのみ変更(upstream 挙動)。
  - `packages/server/src/server/agent/agent-manager.ts` の `setAgentModel`: 指定 provider が現在と
    異なる場合、`reloadAgentSession` でセッションを新 provider 上に再構築し、永続化済みのネイティブ
    sessionId をそのまま resume する(会話は持ち越し)。`thinkingOptionId` は破棄(そのモデル固有の
    ため)。`reloadAgentSessionInternal` の provider 決定を `overrides.provider ?? handle.provider ??
existing.provider` に変更した。
  - `packages/client/src/daemon-client.ts` / `agent-config-session.ts` / `session.ts`: 上記
    optional provider の中継。
  - `packages/app/src/composer/agent-controls/index.tsx`: 実行中エージェントのモデルピッカーで
    「その agent 自身の provider」だけでなく**有効な全 provider** を出す。別 provider のモデルを選ぶと
    `onSelectProviderAndModel` 経由で上記の切り替えが走る(ドラフト composer と同じ見え方に揃えた)。
  - `packages/app/src/composer/agent-controls/provider-model-select.ts`: モデルピッカー経路と
    **コマンドセンター経路**をこの 1 実装に集約した。コマンドセンターも全 provider を並べるのに、
    選択ハンドラが受け取った provider を捨てて `setAgentModel` を 2 引数で呼んでいたため、別 provider の
    モデルを選んでもセッションは元の provider のままだった(「選べるのに切り替わらない」)。
    ハンドラが 2 箇所に分かれて再びドリフトしないよう、両経路が同じ関数を通る形にしている。
  - 検証: spike(`/tmp/paseo-provider-switch-spike/`)で deepinfra→deepseek / deepinfra→opencodego の
    クロスプロバイダ resume が成立することを実機確認済み。DeepSeek 系の thinking ブロックは
    **signature を持たない**ため、主要な失敗モードは無い。ユニットテストは
    `agent-manager.test.ts`(切り替え/同一 provider 据え置き)と
    `agent-config-session.test.ts`(provider 中継)、および app 側は
    `provider-model-select.test.ts`(provider が渡ること・切替失敗時に preference を書かないこと)に追加。
  - **Anthropic 本家 ⇄ DeepSeek 系の相互切り替え**(2026-10-14 実機で再現・修正)。切り替え操作自体は
    受理されるが、**Claude → DeepSeek 系だけ**、切替後の毎ターンが `422 ... messages[1].content: unknown
variant \`tool_definition\`, expected \`tool_reference\``で失敗していた。原因は thinking signature では
なく、本家で書かれた transcript の`deferred_tools_delta`attachment(ToolSearch で遅延ロードする
ツール名の告知)。resume 時に Claude Code がこれを`tool_definition`ブロックへ描画し、DeepSeek 系の
    Anthropic 互換エンドポイントが未知バリアントとして拒否する。DeepSeek 系 → Claude は元から成立
    (DeepSeek の thinking ブロックは空本文+gateway生成の signature で、本家は resume で受理した)。
    - 修正:`packages/server/src/server/agent/providers/claude/transcript-provider-switch.ts`を新設。
     `ClaudeAgentClient.resumeSession`が、起動 env の`ANTHROPIC_BASE_URL`が`anthropic.com`以外のとき
      resume 前に transcript から`deferred_tools_delta`エントリだけを除去し、子の`parentUuid` を繋ぎ直す
      (ユーザー発言・assistant 本文・tool 結果は不変。原子的に tmp→rename。失敗は warn して resume は続行)。
      provider id でなく env で判定するので、`extends: claude`の任意の派生 provider に効く。
      本家へ戻すと Claude Code が告知を再生成するため、往復しても毎回この除去が効く。
    - 検証: 隔離した試験 daemon(別 home・ポート 6790・修正版ソース)で使い捨て agent を
      claude→deepseek→claude→deepseek→claude→deepseek と 5 回往復し、全ホップで 422 なし・合言葉と
      Bash tool 結果の文脈が継続することを確認。ユニットテストは`transcript-provider-switch.test.ts`。
    - 未検証(出口レビュー指摘, 2026-10-14): 対処は `deferred_tools_delta`のみ。WebSearch の
     `server_tool_use`・`redacted_thinking`・画像/PDF・`/compact` 後の Claude セッションを DeepSeek へ切り替える
      ケース、ツール実行途中(thinking 付き tool_use)での DeepSeek→Claude、DeepSeek 区間での delta の新規生成は
      実機未検証。`anthropic-escape` 経路を provider に使う場合は host 判定で非Anthropic扱いになり、除去が走る
    (告知は再生成されるので実害は小さい)。
  - 既知の未検証: コマンドセンター経由の切り替えは型チェックとユニットテストのみで、実機の
    クリック操作では未確認(修正の性質上、経路が同じ `selectProviderModel` に合流したことの確認まで)。
- **連続するThinkingの結合**(2026-10-04)。`packages/app/src/agent-stream/thinking-merge.ts` を新設し、
  `packages/app/src/agent-stream/presentation.ts` から履歴行とライブheadの両方に適用する。
  Claude系プロバイダは `TaskCreate`/`TaskUpdate`/`TaskList` のたびに `tool_call` をタイムラインへ記録するが、
  クライアントはそれを描画せず捨てる(`types/stream.ts`)。ただし「捨てる」判定より前に、ストリーミング中の
  思考を確定してtailへ送るフラッシュが走る(`shouldFlushHead`)ため、次の思考は新しい行として始まり、
  間に何も表示されない「Thinking」が縦に並んでいた。表示層で隣接するthought(`turnId` が同一のもの)を
  `\n\n` で連結して1行にまとめる。間にツール呼び出し等の可視行がある場合は従来どおり別行のまま。
  先頭のidを保つので find / scroll の宛先は変わらない。サーバ側の `mergeReasoningChunks` は
  seq連続を結合条件にしているため履歴側では元から分裂しており、そちらは変更していない。
  テスト: `thinking-merge.test.ts` と `presentation.test.ts` の `adjacent thinking rows`。
- **確認箱(confirm box)**(2026-10-19)。ToposAI-Mini-Project の watchdog/デーモンが出していたメール通知の
  受け皿。`packages/server/src/server/confirm-box/`(store/push-policy/service/routes/page/index)を新設し、
  `bootstrap.ts` から `setupConfirmBox()` を1回呼ぶだけで組み込む(`/api/health` の直後に登録、listen後に
  `start()`、`stop()` で停止)。`websocket-server.ts` には緊急pushに使う `getPushNotificationSender()` を1つ追加。
  - データ契約はPython側 `antigravity/utils/notify_box.py` と共有: `~/.local/state/toposai/confirm_box/`
    (`TOPOS_CONFIRM_BOX_DIR` で変更可)の `events-YYYYMM.jsonl`(item/ack/ackall/push、O_APPEND単一write、
    ロック不要)と `heartbeat.json`(約15秒毎に原子更新。Python日次死活検査 `confirm_box_liveness_watchdog` が読む)。
  - API: `/api/confirm-box/`(モバイルHTML。緊急=オレンジ/通常=緑、既読/承認/すべて既読)、
    `summary`、`items?view=active|all`、`items/:id/ack`、`ack-all`、`POST items`(外部受信)、`health`。
    パスを `/api/` 配下にしたのは web-ui の SPA fallback が `/api/` を除外するため。認証は既存のbearerに従う。
  - 緊急(未読・未push・6時間以内)のみ Expo push。5分間隔・1時間6回まで、複数は1通に集約、本文は件名のみ
    (`push-policy.ts`)。通常はバッジのみ。**iPhone公式アプリにはフォークUIが届かない**ため、確認は
    Safari→ホーム画面追加のPWA(`http://100.85.224.7:6767/api/confirm-box/`)+push通知で行う。
    push は公式アプリのExpoトークンが登録されている場合だけ届く(トークン0件なら無通知)。
  - `TOPOS_CONFIRM_BOX=0` で無効化。vitest実行中は `TOPOS_CONFIRM_BOX_DIR` 未指定なら無効(本番heartbeatを汚さない)。
  - テスト: `confirm-box/confirm-box.test.ts`(store増分読込・Python契約形式・ack畳込み・push方針・HTTP)。
