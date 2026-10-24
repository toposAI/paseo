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
import type { ConceptZone, SidebarPlace, ZoneCounts } from "./concept-places.js";

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
  /**
   * 構想ノートの区分(`Paseo/構想/検討中` = active / `あとで` = later)。
   * 実装ノートと、旧置き場の構想ノートは `active`(旧置き場に区分は無い)。
   */
  zone: z.enum(["active", "later"]).default("active"),
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
    /** 構想の置き場(`paseo` = `Paseo/構想/…` を読んでいる / `legacy` = 旧置き場だけ)。 */
    place: z.enum(["paseo", "legacy"]).default("legacy"),
    /**
     * 構想の件数(検討中/あとで)。`laterAvailable=false` のときは「あとで」の区分を作れない
     * (新置き場がまだ無い=別スレの移行前)ので、画面は切替の入口を出さない。
     */
    zones: z
      .object({
        active: z.number(),
        later: z.number(),
        laterAvailable: z.boolean(),
      })
      .default({ active: 0, later: 0, laterAvailable: false }),
  }),
});
export type NotesSidebarOutput = z.infer<typeof notesSidebarRpc.output>;

/**
 * 構想ノートをタップしたとき: そのノートの深掘りスレを開く(無ければ作る)。
 *
 * - ノート側のスレID(`thread` / `threads` / 実在の子スレ)があれば、作らずにそのスレを開く。
 * - 無ければ深掘りスレを1本作り、ノートの `thread:` にIDを記録する。連打しても、
 *   同じノートの作成はサーバー側で1本に畳まれる(作成中は待ち合わせ、記録まで済んだら作り直さない)。
 * - 作った直後、最初の発話が失敗していないかを短く見る(`startError`)。作るだけでは
 *   「スレはあるが何も始まらない」=押しても開かないように見える失敗が残るため。
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
    /**
     * **作ったが最初の発話が失敗した**(受付外モデル・残高・通信など)。画面も必ず理由を出す。
     * 古いクライアント・サーバーと揃えるため省略可(undefined=未確認)。
     */
    startError: z.string().nullable().optional(),
  }),
});
export type OpenConceptThreadOutput = z.infer<typeof openConceptThreadRpc.output>;

/**
 * 構想ノートを「検討中」と「あとで」の間で移す(2026-10-24 ユーザー指示: ずっと寝かせる構想を
 * あとでフォルダへ)。移動先は `<Vault>/Paseo/構想/{検討中,あとで}`(新置き場が無ければ不可)。
 *
 * **書き込み側のガード**(`server/note-thread.ts` の `moveConceptNote`): live Vault の構想ノートだけ・
 * 置き場の直下だけ・同名があれば上書きしない・排他と原子的 rename。置き場の単一ライター
 * (`impl_note_writer.py`)が移行の関数を持つようになったら、その関数へ差し替える。
 */
export const moveConceptNoteRpc = defineRpc({
  name: "topos.notes.move-concept",
  input: z.object({
    /** 一覧(`notesSidebarRpc`)が返したノートの絶対パス。サーバー側で区分と場所を確かめ直す。 */
    path: z.string().min(1).max(4096),
    to: z.enum(["active", "later"]),
  }),
  output: z.object({
    ok: z.boolean(),
    /** 移した後のパス(ok のときだけ)。 */
    path: z.string().nullable().default(null),
    message: z.string().default(""),
  }),
});
export type MoveConceptNoteOutput = z.infer<typeof moveConceptNoteRpc.output>;
export type { ConceptZone, SidebarPlace, ZoneCounts };

/**
 * 深掘りスレの既定(2026-10-23 の実装判断。ユーザー指示「不明ならTopos既定=DeepSeek V4.1 flash low」)。
 *
 * Paseo 本体の新規スレは「画面で最後に選んだモデル」を既定にするが、その選択は端末側の設定にあり、
 * 插件からは読めない(SSOT が端末に1つしかない)。読めるようになるまではこの値を明示的に渡す。
 *
 * **モデルIDは固定しない**(2026-10-23 実機: 固定値 `deepseek/deepseek-v4.1-flash` は当デーモンの
 * deepseek プロバイダで受付外で、スレは作られるが最初の発話が HTTP 400 で失敗し、画面上は
 * 「押しても開かない」ように見えた)。デーモンが申告するモデル一覧と突き合わせて選ぶ。
 * `provider/model` の `provider` が Paseo のプロバイダID(スレの provider 欄)。
 */
export const CONCEPT_THREAD_DEFAULT = {
  provider: "deepseek",
  /**
   * 同じプロバイダの別名口(`opencodego` など)から探す順。deepseek に受付るモデルが1つも
   * 無ければ、ここへ落ちる。空配列なら deepseek の既定モデルを使う。
   */
  fallbackProviders: ["opencodego"],
  /** 選ぶ優先順。find で最初に一致したもの(`flash` が無ければ `pro` に落ちる)。 */
  modelPatterns: [/flash/i, /deepseek/i],
  /** 低い方の effort(off 無しの語彙。モデル一覧に無ければ null=モデルの既定)。 */
  thinkingOptionId: "low",
} as const;

/** モデル一覧の1件(デーモンの申告のうち、選定に要る分だけ)。 */
export interface ConceptModelOption {
  provider: string;
  id: string;
  label?: string;
  /** 一覧に出る選択肢(既定で true)。 */
  isSelectable?: boolean;
  thinkingOptions?: readonly { id: string }[];
}

/** プロバイダごとの、モデル一覧を引く関数(null=引けなかった)。 */
export type ConceptModelCatalog = (
  provider: string,
) => Promise<readonly ConceptModelOption[] | null>;

export interface ConceptModelPick {
  /** `agents.create` の `config.provider`(`provider/model` 形式)。 */
  providerModel: string;
  provider: string;
  model: string;
  thinkingOptionId: string | null;
}

function pickModel(
  provider: string,
  models: readonly ConceptModelOption[],
): ConceptModelOption | undefined {
  const usable = models.filter((m) => m.isSelectable !== false);
  for (const pattern of CONCEPT_THREAD_DEFAULT.modelPatterns) {
    const hit = usable.find((m) => pattern.test(`${m.id} ${m.label ?? ""}`));
    if (hit) return hit;
  }
  return usable.find((m) => m.id.toLowerCase().startsWith(provider));
}

function thinkingFor(pick: ConceptModelOption | undefined): string | null {
  const wanted = CONCEPT_THREAD_DEFAULT.thinkingOptionId;
  if (!pick?.thinkingOptions || pick.thinkingOptions.length === 0) return wanted;
  return pick.thinkingOptions.some((o) => o.id === wanted) ? wanted : null;
}

/**
 * 深掘りスレに使うモデルを選ぶ。受付るモデルが全プロバイダで見つからないときは
 * **投げる**(受付外のIDで作ると、スレだけ増えて最初の発話が失敗するため、作らない)。
 */
export async function chooseConceptModel(catalog: ConceptModelCatalog): Promise<ConceptModelPick> {
  const tried: string[] = [];
  for (const provider of [
    CONCEPT_THREAD_DEFAULT.provider,
    ...CONCEPT_THREAD_DEFAULT.fallbackProviders,
  ]) {
    let models: readonly ConceptModelOption[] | null = null;
    try {
      models = await catalog(provider);
    } catch {
      models = null;
    }
    if (models === null) {
      tried.push(`${provider}(一覧を取得できません)`);
      continue;
    }
    const pick = pickModel(provider, models);
    if (pick) {
      return {
        providerModel: `${provider}/${pick.id}`,
        provider,
        model: pick.id,
        thinkingOptionId: thinkingFor(pick),
      };
    }
    tried.push(`${provider}(該当なし)`);
  }
  throw new Error(
    `使用できる DeepSeek 系モデルがデーモンに見つかりません: ${tried.join("・")}。` +
      "モデル設定を確認するか、スレを手で開いてください",
  );
}
