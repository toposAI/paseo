# topos-confirm-box — 設計(2026-10-21)

Paseo の Web UI の中に「統合確認箱」を出す。Topos のユーザー判断待ちと Paseo の承認待ちを
**同じ画面**で見て、その場で決められるようにする。

## 1. 実現方式の決定

**採用: Paseo プラグイン(ローカルディレクトリ型)。コア改造はしない。**

理由:

1. **必要な拡張点が公式APIで揃っている**(実測、下記 §3)。サイドバー項目もヘッダボタンも
   全画面も、`PluginClientContext` に登録メソッドがある。コア改造が要らない。
2. **upstream 追従が楽**。`TOPOS_CUSTOMIZATIONS.md` の規律は「自前コードを最小に保つ」。
   プラグインは `plugins/` 配下の追加のみで、コアの diff がゼロになる。
3. **ビルド・再デプロイが要らない**。ディレクトリ型プラグインはホストがその場で
   TypeScript をコンパイルし、ファイルは**その場で読まれる**(`public-docs/plugins/reference.md`:
   「With `--host`, use an absolute path that exists on the daemon host; plugin files are read there
   and are never uploaded by the CLI.」)。`npm run build:daemon-web-ui` +
   `redeploy-paseo-webui.sh` の経路を通らない = 本番UIの再デプロイを伴わない。
4. **iPhone にも届く**。プラグインのクライアントコードはアプリのバンドルに載り、
   iPhone は 139番 Dictation アプリ内の WebView で同じ Paseo Web UI を見ている
   ([[reference_paseo_web_ui_reaches_iphone_and_pc]])。
5. **検証を本番から隔離できる**。151番の実績どおり `--home <temp>` の捨てデーモンで
   インストール〜表示まで確認できる(本番6767に触らない)。

却下した案:

- **コア改造(`packages/app` に React 画面 + ボタンを足す)**。既存の `ToposThreadCounts`
  (`packages/app/src/components/headers/menu-header.tsx:49-67`)という前例があり見た目は揃うが、
  アプリの再ビルド + `redeploy-paseo-webui.sh` が必須になり、upstream マージのたびに
  `workspace-screen.tsx` / `left-sidebar.tsx` のコンフリクトを負う。今回はプラグインで足りる。
- **既存 `/api/confirm-box/` のPWAページをiframe/WebViewで埋め込む**。そのページは
  単体のモバイルページとして作られていて(自前のヘッダ・PWA誘導)、アプリ内に埋めると
  二重ヘッダになる。React で描き直すほうが素直。
- **`addWorkspacePanel`(ワークスペースのタブ)**。確認箱は**全ワークスペース横断**の
  ものなので、特定ワークスペースのタブに属させるのは筋が悪い。

## 2. 構成

```
plugins/topos-confirm-box/
├─ paseo-plugin.json     id: topos-confirm-box
├─ index.client.tsx      サイドバー項目 + ヘッダボタン + 全画面 を登録
├─ index.server.ts       RPC(list / decide)を登録
├─ shared/contract.ts    Zod の RPC 契約(両ランタイムが import する)
├─ client/               画面・サイドバー行・ヘッダボタン(React)
└─ server/               JSONL の読み書き + Paseo 承認待ちの取得(Node)
```

## 3. 特定した拡張点(ファイル:行)

| 何を             | どのAPI                                        | 根拠                                                                                                                                                                   |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| チャット欄の右上 | `addHeaderButton({id, workspaceId, button})`   | `packages/plugin/src/client/contracts.ts:143`。描画は `packages/app/src/screens/workspace/workspace-screen.tsx:3831-3835` の `headerRight` 内 `<PluginHeaderButtons/>` |
| サイドバー       | `addSidebarHeaderItem({id, title, Component})` | `packages/plugin/src/client/contracts.ts:138`。`SidebarRow`(`packages/plugin/src/client/ui.ts:84`)の `trailing` にバッジを置ける                                       |
| 全画面           | `addScreen({id, title, Component})`            | `packages/plugin/src/client/contracts.ts:137`                                                                                                                          |
| Paseoの承認待ち  | `paseo.agents.list()` の `pendingPermissions`  | `packages/client/src/index.ts:355, 385`                                                                                                                                |

**制約(実測)**: ヘッダボタンは**ワークスペース単位**で登録する(`workspaceId` 必須。
`packages/app/src/plugins/buttons/view.tsx:561` の `useButtons(serverId, workspaceId, null)` が
現在のワークスペースでフィルタする)。よってワークスペース一覧を購読して各々に登録する。
コンパクト(iPhone)では表示枠が1個しかない(`view.tsx:569` `limit = compact || width < 1100 ? 1 : 3`)
ため、ヘッダボタンは**補助**で、主たる入口はサイドバー側に置く。

## 4. データ源

1. **Topos のユーザー判断**: `~/.local/state/toposai/confirm_box/pending_user_decisions.jsonl`
   (`TOPOS_CONFIRM_BOX_DIR` で変更可)。append-only JSONL。
   - `t` の無い行 = 未決の判断項目(`key`/`subject`/`summary`/`priority`/`subrank`/`group`/
     `background`/`source`/`thread_ref`/`stopped_count`/`options`/`recommended`)
   - `t:"decision"` = 決定済み(`key` で突き合わせて未決から外す)
   - `t:"chat"` = チャット欄の記録(この版では表示しない)
   - **壊れた行・未知の `t` は無視する**(契約)。
2. **Paseo の承認待ち**: `paseo.agents.list()` の `pendingPermissions`(実行時に引く。
   自前で状態を持たないのでプラグイン再読込で失われない)。

並び順は投函側の設計どおり `priority`(blocking>design>normal>info) → `subrank` → `group` → ts 降順。

## 5. この版の範囲

- v1(このコミット): **読み取り専用**。一覧・優先度順・展開・背景の4段階。
- v1.5(次): 決定の記録(`{"t":"decision",...}` を `pending_user_decisions.jsonl` へ追記)。
  契約は `handoff_confirm_box_recommendation_feedback_kickoff.md` に固定済み。

## 6. 未確認・残差

- 検証デーモン(0.11.2)で Web UI が描画されるところまでの実機確認は未実施
  (151番の記録では 0.11.2 の検証デーモンで Web UI が接続直後に切断された例がある)。
- ヘッダボタンのワークスペース購読が実際に全ワークスペースへ行き渡るかは未実機確認。
- 背景節の redact(`notify_box.redact`)は**投函側で済んでいる前提**。プラグイン側では再適用しない。
