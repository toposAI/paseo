/**
 * 構想ノートを Paseo 画面の中で読む(Obsidian 風の閲覧)ための契約。**読むだけ**で書かない。
 *
 * 2026-10-28 ユーザー決定: 構想の行を押したら、深掘りスレではなくノートの中身を開く。
 * Topos(8777)の Vault ビューアと同じ live Vault(`Obsidian_Vault`)を、Paseo のサーバーから
 * 直接読む(別オリジンのため Topos のトークンは使えない)。読む範囲は Vault の中だけ。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const readNoteRpc = defineRpc({
  name: "topos.notes.read",
  input: z.object({
    /** 一覧が返したノートの絶対パス。サーバー側で Vault の中か確かめ直す。 */
    path: z.string().min(1).max(4096),
  }),
  output: z.object({
    ok: z.boolean(),
    title: z.string().default(""),
    /** frontmatter を除いた本文(Markdown)。 */
    body: z.string().default(""),
    /** frontmatter の主な項目(status / thread など。画面の見出しの補足に使う)。 */
    status: z.string().default(""),
    /** Vault 直下からの相対パス(画面に出す)。 */
    rel: z.string().default(""),
    updatedAt: z.number().default(0),
    /** 本文が上限で切れたか。 */
    truncated: z.boolean().default(false),
    /** ok=false の理由(画面にそのまま出す)。 */
    message: z.string().nullable().default(null),
  }),
});
export type ReadNoteOutput = z.infer<typeof readNoteRpc.output>;

export const resolveNoteLinkRpc = defineRpc({
  name: "topos.notes.resolve-link",
  input: z.object({
    /** リンクを含むノートの絶対パス(同じフォルダを優先するため)。 */
    from: z.string().min(1).max(4096),
    /** `[[...]]` の中身(`名前|表示名`・`名前#見出し` も可)。 */
    target: z.string().min(1).max(500),
  }),
  output: z.object({
    ok: z.boolean(),
    /** 見つかったノートの絶対パス。 */
    path: z.string().nullable().default(null),
    message: z.string().nullable().default(null),
  }),
});
export type ResolveNoteLinkOutput = z.infer<typeof resolveNoteLinkRpc.output>;

/** ノートを開く画面の ID(`params.path` に絶対パス)。 */
export const NOTE_VIEW_SCREEN_ID = "concept-note";
