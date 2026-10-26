/**
 * 「読んだ位置」の保存・復元の RPC 契約。端末をまたいで同じ位置で開き直すため、位置はデーモン側の
 * 1ファイル(箱ディレクトリの `read_positions.json`)に置く。Paseo 本体のチャット画面が
 * メソッド名の文字列で直接呼ぶので、名前を変えるときはアプリ側(`use-read-position-sync.ts`)と揃える。
 *
 * Node/React のどちらのAPIも使わない(両ランタイムが import する)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** 既定で記録するスレの題名の目印(完了報告だけを流し続けるスレ)。 */
export const READ_POSITION_DEFAULT_TITLE_MARK = "完了箱C";

/** 設定で上書きされていないスレを記録対象にするか(題名に目印を含むスレだけ)。 */
export function isReadPositionDefaultOn(title: string | undefined): boolean {
  return typeof title === "string" && title.includes(READ_POSITION_DEFAULT_TITLE_MARK);
}

export const readPositionGetRpc = defineRpc({
  name: "topos.readpos.get",
  input: z.object({ agentId: z.string(), title: z.string().optional() }),
  output: z.object({
    /** このスレで記録・復元が働くか。 */
    enabled: z.boolean(),
    /** 最後まで表示した行の通し番号と、その番号が属する履歴の世代。未記録なら null。 */
    seq: z.number().nullable(),
    epoch: z.string().nullable(),
    updatedAt: z.number().nullable(),
  }),
});

export const readPositionSetRpc = defineRpc({
  name: "topos.readpos.set",
  input: z.object({
    agentId: z.string(),
    title: z.string().optional(),
    seq: z.number(),
    epoch: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** 保存後の位置(同じ世代で小さい値は採らないので、送った値と違うことがある)。 */
    seq: z.number().nullable(),
    message: z.string().optional(),
  }),
});

/** スレ単位の切り替え。`enabled: null` で上書きを消して既定(題名の目印)に戻す。 */
export const readPositionEnableRpc = defineRpc({
  name: "topos.readpos.enable",
  input: z.object({ agentId: z.string(), enabled: z.boolean().nullable() }),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});
