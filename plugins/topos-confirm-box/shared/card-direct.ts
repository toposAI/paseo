/**
 * 判断カードを**モデルに書き写させず**、スクリプトから画面へそのまま出す試作の契約。
 *
 * 流れ(2026-11-01 壁打ち4 の判断):
 *   モデルはスクリプト1本を実行するだけ → スクリプトが `topos.carddirect.show` を呼ぶ
 *   → プラグインが `judgment_window.py next` の返したカードを**そのまま**タイムライン行にする。
 *   本文はモデルの返答に載せない(スクリプトの標準出力にも載せない)。
 *
 * 読む先は本物(`cards/<id>.json` / 判断ノート)でよいが、`next` / `finish` が書く状態は
 * 検証時は一時コピーへ向ける(呼ぶ側の環境変数で切り替える。ここでは決めない)。
 */
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** タイムライン行の種別。クライアントの `addTimelineRenderer` と同じ値にする。 */
export const CARD_DIRECT_KIND = "judgment-card";
export const CARD_DIRECT_VERSION = 1;

export const CardDirectOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});
export type CardDirectOption = z.infer<typeof CardDirectOptionSchema>;

/** 行に載せるデータ。**カードの全文**をそのまま持つ(画面はこれを表示するだけ)。 */
export const CardDirectDataSchema = z.object({
  cardId: z.string(),
  window: z.string(),
  question: z.string(),
  options: z.array(CardDirectOptionSchema),
  recommended: z.string(),
  /** 出した時刻(ミリ秒)。同じカードを出し直したときに行を見分ける。 */
  shownAt: z.number(),
});
export type CardDirectData = z.infer<typeof CardDirectDataSchema>;

/**
 * 次の1問を画面へ出す。呼ぶのはスクリプト(モデルではない)。
 *
 * 戻り値に**本文を含めない**のがこの試作の肝: スクリプトがこの戻り値をそのまま標準出力に出しても、
 * モデルの返答にカード本文が載らない(条件2)。
 */
export const cardDirectShowRpc = defineRpc({
  name: "topos.carddirect.show",
  input: z.object({
    /** 行を出すスレ(窓口Aのスレ)。 */
    agentId: z.string(),
    window: z.string().default("A"),
  }),
  output: z.object({
    shown: z.boolean(),
    cardId: z.string().default(""),
    /** 出さなかった理由(paused / no_card / 点検前 など)。 */
    reason: z.string().default(""),
    /// 本文の長さだけ返す(出したことの確認用。本文そのものは返さない)。
    questionChars: z.number().int().default(0),
    optionCount: z.number().int().default(0),
  }),
});

/**
 * 行のボタンを押したときの回答。押した**その場**で記録する(モデルを経由しない)。
 *
 * 二重記録を防ぐため、次の4つを機械で弾く(2026-11-01 の通過条件4):
 *   1. 出題停止の印(PAUSED)がある → paused
 *   2. そのスレでいま出している行ではない(古い行) → stale
 *   3. そのカードはもう答えた(二度押し・連打) → duplicate
 *   4. カードの本文が変わった(作り直された) → changed
 */
export const cardDirectAnswerRpc = defineRpc({
  name: "topos.carddirect.answer",
  input: z.object({
    agentId: z.string(),
    cardId: z.string(),
    /** 選んだ選択肢の id。 */
    choiceId: z.string(),
    /** 記録する回答原文。省略時は選んだ選択肢の見出し(逐語)。 */
    answer: z.string().default(""),
  }),
  output: z.object({
    ok: z.boolean(),
    /** judgment_window.py finish の status(queued / already_queued / not_open ...)。 */
    recorded: z.string().default(""),
    /** 弾いた理由(paused / stale / duplicate / changed / ...)。 */
    reason: z.string().default(""),
    nextCardId: z.string().default(""),
    shownNext: z.boolean().default(false),
  }),
});

/** 試作の動作確認用(いま何を出しているか。読み取りのみ)。 */
export const cardDirectStateRpc = defineRpc({
  name: "topos.carddirect.state",
  input: z.object({ agentId: z.string().default("") }),
  output: z.object({
    agents: z.record(
      z.string(),
      z.object({
        cardId: z.string().default(""),
        shownAt: z.number().default(0),
        answered: z.array(z.string()).default([]),
      }),
    ),
  }),
});
