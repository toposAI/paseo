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
