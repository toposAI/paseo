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
  - 検証: spike(`/tmp/paseo-provider-switch-spike/`)で deepinfra→deepseek / deepinfra→opencodego の
    クロスプロバイダ resume が成立することを実機確認済み。DeepSeek 系の thinking ブロックは
    **signature を持たない**ため、主要な失敗モードは無い。ユニットテストは
    `agent-manager.test.ts`(切り替え/同一 provider 据え置き)と
    `agent-config-session.test.ts`(provider 中継)に追加。
  - 既知の未検証: Anthropic 本家(thinking signature を検証する)との相互切り替え方向は未検証。
    失敗した場合の緩和策(resume 失敗時に履歴から thinking ブロックを落として再試行)は未実装。
