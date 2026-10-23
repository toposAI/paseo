import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseConceptModel } from "../shared/notes.js";
import type { ConceptModelCatalog, ConceptModelOption } from "../shared/notes.js";

const flash = (id: string, thinking = ["off", "low", "high"]): ConceptModelOption => ({
  provider: "x",
  id,
  label: id,
  thinkingOptions: thinking.map((t) => ({ id: t })),
});

/** プロバイダ → 一覧(無いプロバイダは throw = 引けないを表す)。 */
const catalogOf = (byProvider: Record<string, ConceptModelOption[]>): ConceptModelCatalog => {
  return async (provider) => {
    const models = byProvider[provider];
    if (!models) throw new Error(`disabled: ${provider}`);
    return models;
  };
};

test("deepseek に受付モデルが出なければ、申告されたIDをそのまま使い固定IDで補填しない", async () => {
  // 2026-10-23 実機: 固定値 deepseek/deepseek-v4.1-flash は受付外で最初の発話が HTTP 400 になった。
  // デーモンの申告は deepseek-flash。ここでは申告が別IDに変わっていても申告に従うことを見る。
  const pick = await chooseConceptModel(
    catalogOf({ deepseek: [flash("deepseek-flash")], opencodego: [flash("deepseek-v4.1-flash")] }),
  );
  assert.equal(pick.providerModel, "deepseek/deepseek-flash");
  assert.equal(pick.thinkingOptionId, "low");
});

test("deepseek の一覧が引けなければ opencodego へ落ちる", async () => {
  const pick = await chooseConceptModel(catalogOf({ opencodego: [flash("deepseek-v4.1-flash")] }));
  assert.equal(pick.providerModel, "opencodego/deepseek-v4.1-flash");
});

test("low を持たないモデルでは effort を送らない(モデル既定に任せる)", async () => {
  const pick = await chooseConceptModel(
    catalogOf({ deepseek: [flash("deepseek-flash", ["high"])] }),
  );
  assert.equal(pick.thinkingOptionId, null);
});

test("選択不可(isSelectable=false)のモデルは選ばない", async () => {
  const disabled: ConceptModelOption = { ...flash("deepseek-flash"), isSelectable: false };
  const pick = await chooseConceptModel(
    catalogOf({ deepseek: [disabled, flash("deepseek-v4-pro")] }),
  );
  assert.equal(pick.model, "deepseek-v4-pro");
});

test("どのプロバイダにも使えるモデルが無ければ投げる(スレを作らせない)", async () => {
  await assert.rejects(
    () => chooseConceptModel(catalogOf({ deepseek: [], opencodego: [] })),
    /使用できる DeepSeek 系モデルがデーモンに見つかりません/,
  );
});
