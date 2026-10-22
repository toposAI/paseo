/**
 * サイドバー二段(上段=実装ノート、下段=進行中の構想)が読む Vault ノートの契約。
 *
 * **status の正はノートの frontmatter `status:`**(正本:
 * `05_Projects/ToposAI/壁打ちノートをVaultに残す標準/標準_サイドバーの表示ルール.md`)。
 * この RPC は**読むだけ**で、ノートを書き換えない(書き手は司令塔スレに固定)。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** ノートの status 語彙(標準_スレは検収単位)。 */
export const NOTE_STATUSES = [
  "構想",
  "壁打ち中",
  "実装中",
  "判断待ち",
  "確認待ち",
  "完了",
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/**
 * 旧語彙の読み替え。子スレの自己申告(`child_threads.json`)は `ユーザー判断待ち` を使う。
 * ノート語彙の `判断待ち` と同じ意味として扱う(表示は語彙側へ寄せる)。
 */
export const NOTE_STATUS_ALIASES: Readonly<Record<string, NoteStatus>> = {
  ユーザー判断待ち: "判断待ち",
};

/** ノートの種類。frontmatter `type:` から決める。 */
export const NOTE_KINDS = ["implementation", "concept"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** **上段**に並べる status(実装ノート)。`完了` は確認待ちの間だけ別判定で残す。 */
export const UPPER_TIER_STATUSES: readonly NoteStatus[] = ["実装中", "判断待ち", "確認待ち"];
/** **下段**に並べる status(進行中の構想)。 */
export const LOWER_TIER_STATUSES: readonly NoteStatus[] = ["構想", "壁打ち中"];

/** 未知の status を語彙へ寄せる。未知なら null(ノートとして扱わない)。 */
export function normalizeNoteStatus(raw: unknown): NoteStatus | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  const aliased = NOTE_STATUS_ALIASES[value];
  const candidate = aliased ?? value;
  return (NOTE_STATUSES as readonly string[]).includes(candidate)
    ? (candidate as NoteStatus)
    : null;
}

export const SidebarNoteSchema = z.object({
  /** Vault 内の絶対パス。行の安定キー(ノートを改名したら別行になる)。 */
  path: z.string(),
  kind: z.enum(NOTE_KINDS),
  status: z.enum(NOTE_STATUSES),
  title: z.string(),
  /** 下段の行に出す1行の結論。無ければ空文字。 */
  conclusion: z.string().default(""),
  /** タップで開くスレ。書かれていない/存在しないときは null。 */
  threadId: z.string().nullable().default(null),
  /** ノートに書かれたスレID候補(先頭が優先)。タップ時に存在確認してから開く。 */
  threadCandidates: z.array(z.string()).default([]),
  /** 実装ノートが参照する構想ノート(wikilink の生文字列)。 */
  conceptLinks: z.array(z.string()).default([]),
  updatedAt: z.number(),
});
export type SidebarNote = z.infer<typeof SidebarNoteSchema>;

export const notesSidebarRpc = defineRpc({
  name: "topos.notes.sidebar",
  input: z.object({}),
  output: z.object({
    notes: z.array(SidebarNoteSchema),
    /** 走査したディレクトリ(画面に出す。どこを見ているか分かるように)。 */
    roots: z.array(z.string()),
    generatedAt: z.number(),
    /** 走査上限に当たって打ち切ったか。 */
    truncated: z.boolean().default(false),
    /** 走査したファイル数(診断用)。 */
    scanned: z.number().default(0),
    /** 読めなかった理由(設定誤りなど)。正常時は無い。 */
    error: z.string().optional(),
  }),
});
export type NotesSidebarOutput = z.infer<typeof notesSidebarRpc.output>;
