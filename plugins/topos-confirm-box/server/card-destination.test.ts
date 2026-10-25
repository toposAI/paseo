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

test("親があれば親(0378115 の例: F-80司令塔)", () => {
  const c = ctx([entry({ agentId: "03781154-7641-438d-9ae0-a65aec5add12", parentAgentId: F80 })]);
  const d = resolveCardDestination(["0378115"], "j-x", c);
  assert.equal(d.id, F80);
  assert.equal(d.reason, "parent");
  assert.equal(d.label, "afe8d17 F-80司令塔");
});

test("親が司令塔でなくても親へ(上のスレは司令塔とは限らない)", () => {
  const c = ctx([entry({ agentId: CHILD, parentAgentId: PARENT_THREAD, parentTitle: "設計スレ" })]);
  const d = resolveCardDestination(["c1111111"], "j-x", c);
  assert.equal(d.id, PARENT_THREAD);
  assert.equal(d.label, "9999999 設計スレ");
});

test("親が無ければ投函元本人", () => {
  const c = ctx([entry({ agentId: CHILD, title: "単体スレ" })]);
  const d = resolveCardDestination(["c1111111"], "j-x", c);
  assert.equal(d.id, CHILD);
  assert.equal(d.reason, "self");
});

test("親がアーカイブ済みなら領域司令塔、無ければ総司令塔", () => {
  const c = ctx([
    entry({ agentId: PARENT_THREAD, archived: true }),
    entry({ agentId: CHILD, parentAgentId: PARENT_THREAD }),
  ]);
  assert.equal(resolveCardDestination(["c1111111"], "j-f80-foo", c).id, F80);
  assert.equal(resolveCardDestination(["c1111111"], "j-other", c).id, GENERAL);
});

test("未登録の投函元は未登録と明示し、領域推定で領域司令塔へ。推定できなければ総司令塔", () => {
  const c = ctx([]);
  const f = resolveCardDestination(["deadbeef"], "j-20261025-f80-proper-noun", c);
  assert.equal(f.id, F80);
  assert.equal(f.label, "未登録の投函元 → afe8d17 F-80司令塔");
  const g = resolveCardDestination([], "j-misc", c);
  assert.equal(g.id, GENERAL);
  assert.match(g.label, /未登録/);
});

test("祖父母には上がらない(親が閉じたら領域→総司令塔)", () => {
  const c = ctx([
    entry({ agentId: PARENT_THREAD, archived: true, parentAgentId: F80 }),
    entry({ agentId: CHILD, parentAgentId: PARENT_THREAD }),
  ]);
  assert.equal(resolveCardDestination(["c1111111"], "j-misc", c).id, GENERAL);
});

test("司令塔自身が投函した(threads に司令塔)なら本人", () => {
  const d = resolveCardDestination(["afe8d17"], "j-x", ctx([]));
  assert.equal(d.id, F80);
  assert.equal(d.reason, "self");
});

test("inferDomain", () => {
  assert.equal(inferDomain("f80-foo"), "f80");
  assert.equal(inferDomain("zzz"), null);
});
