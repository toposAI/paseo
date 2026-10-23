/**
 * サイドバー二段(上段=実装ノート、下段=進行中の構想)が読む Vault ノートの契約。
 *
 * **status の正はノートの frontmatter `status:`**(正本:
 * `05_Projects/ToposAI/壁打ちノートをVaultに残す標準/標準_サイドバーの表示ルール.md`)。
 * 一覧(`notesSidebarRpc`)は**読むだけ**で、ノートを書き換えない。
 *
 * 唯一の例外が `openConceptThreadRpc`: 構想ノートをタップしたときに**深掘りスレを作り**、
 * そのIDを frontmatter の `thread:` 1行へ書く(2026-10-23 ユーザー決定=案B)。書き込みの
 * ガードは `server/note-thread.ts` に隔離してあり、書くのはその1行だけ。
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

/**
 * 構想ノートをタップしたとき: そのノートの深掘りスレを開く(無ければ作る)。
 *
 * - ノート側のスレID(`thread` / `threads` / 実在の子スレ)があれば、作らずにそのスレを開く。
 * - 無ければ深掘りスレを1本作り、ノートの `thread:` にIDを記録する。連打しても、
 *   同じノートの作成はサーバー側で1本に畳まれる(作成中は待ち合わせ、記録まで済んだら作り直さない)。
 */
export const openConceptThreadRpc = defineRpc({
  // RPC 名は小文字のみ(`defineRpc` が `/^[a-z][a-z0-9._-]*$/` で検査する)。
  name: "topos.notes.open-concept-thread",
  input: z.object({
    /** 一覧(`notesSidebarRpc`)が返したノートの絶対パス。サーバー側で構想ノートか確かめ直す。 */
    path: z.string().min(1).max(4096),
  }),
  output: z.object({
    ok: z.boolean(),
    threadId: z.string().nullable().default(null),
    /** この呼び出しでスレを作ったか(false=既存のスレを開いた)。 */
    created: z.boolean().default(false),
    /** ノートの `thread:` への記録(作成方式が変わると、ここが移行先になる)。 */
    record: z.enum(["written", "already", "conflict", "pending", "skipped"]).default("skipped"),
    recordError: z.string().nullable().default(null),
    message: z.string().default(""),
  }),
});
export type OpenConceptThreadOutput = z.infer<typeof openConceptThreadRpc.output>;

/**
 * 深掘りスレの既定(2026-10-23 の実装判断。ユーザー指示「不明ならTopos既定=DeepSeek V4.1 flash low」)。
 *
 * Paseo 本体の新規スレは「画面で最後に選んだモデル」を既定にするが、その選択は端末側の設定にあり、
 * 插件からは読めない(SSOT が端末に1つしかない)。読めるようになるまではこの値を明示的に渡す。
 */
export const CONCEPT_THREAD_DEFAULT = {
  /** `provider/model` 形式(Paseo 側の組み立て規則)。 */
  providerModel: "deepseek/deepseek-v4.1-flash",
  /** claude 系プロバイダの effort 語彙(off 無しの低い方)。 */
  thinkingOptionId: "low",
} as const;
