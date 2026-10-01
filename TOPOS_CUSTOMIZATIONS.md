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
