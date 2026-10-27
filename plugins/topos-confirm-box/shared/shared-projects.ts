/**
 * サイドバー「共有プロジェクト」タブの RPC 契約と純粋関数(2026-10-27 ユーザー依頼)。
 *
 * 見せる範囲は **ユーザー本人が参加している共有プロジェクトだけ**(Topos の `/api/family-projects` が
 * 持ち主のトークンで返す範囲そのまま。参加していないものは Topos 側で存在ごと404)。
 * 範囲を変える口は持たない。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** サイドバーの行・画面の見出しに出す1プロジェクト。 */
export const sharedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  memberCount: z.number(),
  /** 自分以外の未読投稿の数。 */
  unread: z.number(),
  /** そのうち自分宛ての数(強調用)。 */
  mentions: z.number(),
  latestSeq: z.number(),
  /** 最新投稿の1行(無ければ null)。 */
  last: z.object({ author: z.string(), text: z.string(), ts: z.string() }).nullable(),
});
export type SharedProject = z.infer<typeof sharedProjectSchema>;

/**
 * ok=取得できた / unconfigured=接続設定(鍵)がまだ無い / error=Topos に繋がらない・拒否された。
 * unconfigured と error は件数 0 と区別して画面に出す(0件と読ませない)。
 */
export const sharedProjectsStatusSchema = z.enum(["ok", "unconfigured", "error"]);

export const sharedProjectsListRpc = defineRpc({
  name: "topos.projects.list",
  input: z.object({}),
  output: z.object({
    status: sharedProjectsStatusSchema,
    message: z.string().optional(),
    projects: z.array(sharedProjectSchema),
  }),
});

export const sharedMessageSchema = z.object({
  seq: z.number(),
  /** 表示名(Topos の表示名。無ければ ID)。AI の発言は「AI」。 */
  author: z.string(),
  mine: z.boolean(),
  ai: z.boolean(),
  text: z.string(),
  ts: z.string(),
  /** 宛先の表示名(全員宛なら空)。 */
  to: z.array(z.string()),
  /** 添付の数(本文は出さない。Topos の画面で見る)。 */
  attachments: z.number(),
});
export type SharedMessage = z.infer<typeof sharedMessageSchema>;

export const sharedProjectThreadRpc = defineRpc({
  name: "topos.projects.thread",
  input: z.object({ id: z.string() }),
  output: z.object({
    status: sharedProjectsStatusSchema,
    message: z.string().optional(),
    messages: z.array(sharedMessageSchema),
    latestSeq: z.number(),
    unread: z.number(),
  }),
});

/** 投稿(宛先なし=全員宛。AI には聞かない)。 */
export const sharedProjectPostRpc = defineRpc({
  name: "topos.projects.post",
  input: z.object({ id: z.string(), text: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});

/** 既読にする(画面を開いたとき)。 */
export const sharedProjectReadRpc = defineRpc({
  name: "topos.projects.read",
  input: z.object({ id: z.string(), seq: z.number() }),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});

/** 投稿の本文の上限(Topos の TEXT_MAX と同じ。超えたら送らず画面で知らせる)。 */
export const POST_TEXT_MAX = 8000;

/** 画面の見出しの未読表示。0 は出さない。 */
export function unreadLabel(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

/** サイドバーの下部バーのバッジ(未読の合計)。取得できていないときは出さない。 */
export function totalUnread(projects: readonly { unread: number }[]): number {
  return projects.reduce((sum, p) => sum + Math.max(0, p.unread), 0);
}

/** 一覧が空のときの行の文言。 */
export function emptyProjectsLabel(status: "ok" | "unconfigured" | "error"): string {
  if (status === "unconfigured") return "共有プロジェクトの接続設定がありません";
  if (status === "error") return "共有プロジェクトを取得できません";
  return "参加中の共有プロジェクトはありません";
}

/** 投稿してよい本文か(空白だけ・長すぎるものは送らない)。 */
export function canPost(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= POST_TEXT_MAX;
}

/** ISO 時刻を「M/D HH:MM」(端末のローカル時刻)に整える。読めない値はそのまま返す。 */
export function shortTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
