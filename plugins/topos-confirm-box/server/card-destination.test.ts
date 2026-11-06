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
