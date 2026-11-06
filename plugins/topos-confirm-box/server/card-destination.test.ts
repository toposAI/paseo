import assert from "node:assert/strict";
import test from "node:test";
import { inferDomain, resolveCardDestination } from "./card-destination.js";
import type { RegistryEntry, RoutingContext } from "./card-destination.js";

const F80 = "afe8d176-d92c-4cb2-933b-8dfe790d3c20";
const GENERAL = "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49";
const PARENT_THREAD = "99999999-aaaa-bbbb-cccc-000000000001";
const CHILD = "c1111111-0000-0000-0000-000000000001";
const entry = (o: Partial<RegistryEntry> & { agentId: string }): RegistryEntry => ({
  title: "子スレ",
  parentAgentId: null,
  parentTitle: null,
  archived: false,
  ...o,
});
const ctx = (registry: RegistryEntry[]): RoutingContext => ({
  registry,
  domainCoordinators: { general: GENERAL, f80: F80 },
});

test("親がいても答えるのは投函元本人(窓口へ流さない)", () => {
  const c = ctx([
    entry({ agentId: "03781154-7641-438d-9ae0-a65aec5add12", parentAgentId: PARENT_THREAD }),
  ]);
  const d = resolveCardDestination(["0378115"], "j-x", c);
  assert.equal(d.id, "03781154-7641-438d-9ae0-a65aec5add12");
  assert.equal(d.reason, "self");
});

test("親が無ければ投函元本人", () => {
  const c = ctx([entry({ agentId: CHILD, title: "単体スレ" })]);
  const d = resolveCardDestination(["c1111111"], "j-x", c);
  assert.equal(d.id, CHILD);
  assert.equal(d.reason, "self");
});

test("投函元がアーカイブ済みなら親→領域司令塔→総司令塔", () => {
  const c = ctx([
    entry({ agentId: PARENT_THREAD, archived: true }),
    entry({ agentId: CHILD, parentAgentId: PARENT_THREAD, archived: true }),
  ]);
  assert.equal(resolveCardDestination(["c1111111"], "j-f80-foo", c).id, F80);
  assert.equal(resolveCardDestination(["c1111111"], "j-other", c).id, GENERAL);
});

test("未登録の投函元・投函元なしは投函元不明(別のスレへ流さない)", () => {
  const c = ctx([]);
  for (const t of [["deadbeef"], []]) {
    const d = resolveCardDestination(t, "j-20261025-f80-x", c);
    assert.equal(d.id, null);
    assert.equal(d.reason, "unresolved");
    assert.match(d.label, /^投函元不明/);
  }
});

test("司令塔自身が投函した(threads に司令塔のID)なら本人", () => {
  const c = ctx([]);
  assert.equal(resolveCardDestination([F80], "j-x", c).id, F80);
});

test("inferDomain", () => {
  assert.equal(inferDomain("f80-foo"), "f80");
  assert.equal(inferDomain("zzz"), null);
});

// 2026-11-06 ユーザー再指摘: Topos製品のカードは総司令塔ではなくTopos司令塔と話す
const TOPOS = "48d65c40-7aaf-403d-a33e-cc4edcc4b6ac";
const OLD_TOPOS = "5a226b97-90e8-40f3-831b-72c251deb3d7";

const toposRegistry: RegistryEntry[] = [
  entry({ agentId: OLD_TOPOS, title: "Topos司令塔", status: "完了", updatedAt: 1 }),
  entry({ agentId: TOPOS, title: "Topos司令塔", status: "待機", updatedAt: 2 }),
  entry({
    agentId: "ca3e33e5-5cda-4e30-b2d3-dcd92c01c2c1",
    title: "Topos司令塔へのカード転送(140c)",
  }),
];

test("投函元不明でも家族報告のカードはTopos司令塔へ(総司令塔へ流さない)", () => {
  const c = ctx(toposRegistry);
  const d = resolveCardDestination(
    ["deadbeef"],
    "j-20261106-fb-x 家族報告(要望): 会話をまとめたい",
    c,
  );
  assert.equal(d.id, TOPOS); // 状態「完了」の旧司令塔は使わない
  assert.equal(d.reason, "domain");
  assert.equal(d.registered, false);
});

test("Topos司令塔を登録簿から引けないときだけ従来どおり宛先なし", () => {
  const c = ctx([]);
  const d = resolveCardDestination([], "j-fb-x 家族報告", c);
  assert.equal(d.id, null);
  assert.equal(d.reason, "unresolved");
});

test("Topos以外の投函元不明カードは従来どおり宛先なし", () => {
  const c = ctx(toposRegistry);
  for (const t of [["deadbeef"], []]) {
    const d = resolveCardDestination(t, "j-20261025-f80-x", c);
    assert.equal(d.id, null);
    assert.equal(d.reason, "unresolved");
  }
});

test("投函元がアーカイブ済みの家族報告もTopos司令塔へ", () => {
  const c = ctx([
    ...toposRegistry,
    entry({ agentId: CHILD, archived: true, title: "家族報告の子スレ" }),
  ]);
  const d = resolveCardDestination(["c1111111"], "j-fb-x 家族版Topos", c);
  assert.equal(d.id, TOPOS);
});

test("投函元が総司令塔本人のToposカードもTopos司令塔へ(ユーザー逐語)", () => {
  const c = ctx([...toposRegistry, entry({ agentId: GENERAL, title: "総司令塔" })]);
  const d = resolveCardDestination([GENERAL], "j-fb-x 家族報告", c);
  assert.equal(d.id, TOPOS);
  assert.equal(d.reason, "domain");
  assert.equal(d.registered, false);
});

test("投函元が総司令塔本人でもTopos以外のカードは従来どおり本人", () => {
  const c = ctx([...toposRegistry, entry({ agentId: GENERAL, title: "総司令塔" })]);
  const d = resolveCardDestination([GENERAL], "j-20261025-f80-x", c);
  assert.equal(d.id, GENERAL);
  assert.equal(d.reason, "self");
});

test("投函元が子スレのToposカードは本人のまま(文脈を持つ本人を優先)", () => {
  const c = ctx([...toposRegistry, entry({ agentId: CHILD, title: "家族報告の子スレ" })]);
  const d = resolveCardDestination(["c1111111"], "j-fb-x 家族報告", c);
  assert.equal(d.id, CHILD);
  assert.equal(d.reason, "self");
});

test("登録簿に無い総司令塔が投函したToposカードもTopos司令塔へ", () => {
  // child_threads.json に総司令塔の行がまだ無い(起こした直後など)場合。threads は
  // domainCoordinators.general(=backoffice の正本)で照合する。
  const c = ctx(toposRegistry);
  const d = resolveCardDestination([GENERAL], "j-fb-x 家族報告", c);
  assert.equal(d.id, TOPOS);
  assert.equal(d.reason, "domain");
});

test("登録簿に無い総司令塔でもTopos以外のカードは本人", () => {
  const c = ctx(toposRegistry);
  const d = resolveCardDestination([GENERAL], "j-20261025-f80-x", c);
  assert.equal(d.id, GENERAL);
  assert.equal(d.reason, "self");
});

test("「ToposAI」はTopos製品の合図にしない(部分一致の誤爆を避ける)", () => {
  const c = ctx(toposRegistry);
  for (const hint of ["j-x ToposAIのデーモン", "j-x topos_ai の設定", "j-x TOPOS-AI"]) {
    const d = resolveCardDestination(["deadbeef"], hint, c);
    assert.equal(d.id, null, hint);
    assert.equal(d.reason, "unresolved", hint);
  }
});
