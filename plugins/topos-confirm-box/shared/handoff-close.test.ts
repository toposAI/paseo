import assert from "node:assert/strict";
import test from "node:test";
import {
  HANDOFF_TARGET_LIMIT,
  externalCloseRefusal,
  handoffClosePrompt,
  handoffTargets,
  menuCanHandoffClose,
} from "./handoff-close.js";

const row = (
  agentId: string,
  title: string,
  extra: { parentAgentId?: string; coordinator?: boolean } = {},
) => ({
  agentId,
  title,
  parentAgentId: extra.parentAgentId ?? null,
  coordinator: extra.coordinator ?? false,
});

test("既定の引き継ぎ先は親で、先頭に来る", () => {
  const self = row("self0001", "表と写真表示の壁打ち", { parentAgentId: "parent01" });
  const threads = [self, row("other001", "別の壁打ち"), row("parent01", "総司令塔")];
  const targets = handoffTargets(self, threads);
  assert.equal(targets[0]?.agentId, "parent01");
  assert.equal(targets[0]?.isParent, true);
  // 自分は候補に出さない(自分自身へ引き継ぐ事故を画面側でも作らない)
  assert.equal(
    targets.some((t) => t.agentId === "self0001"),
    false,
  );
});

test("題名が空の行は候補に出さない(取り違えの元)", () => {
  const self = row("self0001", "壁打ち");
  const targets = handoffTargets(self, [self, row("blank001", "   ")]);
  assert.deepEqual(targets, []);
  assert.equal(menuCanHandoffClose(targets), false);
});

test("司令塔は親の次に並ぶが、重複しない", () => {
  const self = row("self0001", "壁打ち", { parentAgentId: "parent01" });
  const threads = [
    self,
    row("aux00001", "補助"),
    row("hub00001", "総司令塔", { coordinator: true }),
    row("parent01", "子司令塔", { coordinator: true }),
  ];
  const targets = handoffTargets(self, threads);
  const ids = targets.map((t) => t.agentId);
  assert.equal(ids[0], "parent01");
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.includes("hub00001"), true);
});

test("候補は上限で切る", () => {
  const self = row("self0001", "壁打ち");
  const many = Array.from({ length: HANDOFF_TARGET_LIMIT + 5 }, (_, i) =>
    row(`t${String(i).padStart(7, "0")}`, `スレ${i}`),
  );
  assert.equal(handoffTargets(self, many).length, HANDOFF_TARGET_LIMIT);
});

test("外からのアーカイブは壁打ち・司令塔・親の行を断る(閉じるのはユーザーのボタンだけ)", () => {
  const rows = [
    row("wall0001", "壁打ち", { parentAgentId: "parent01" }),
    row("parent01", "子司令塔"),
    row("plain001", "普通の子スレ"),
    row("hub00001", "総司令塔", { coordinator: true }),
  ];
  const sideOf = (id: string) => (id === "wall0001" ? "walltalk" : undefined);
  assert.match(
    String(externalCloseRefusal({ agentId: "wall0001", rows, sideOf })),
    /引き継いで閉じる/,
  );
  // 子を持つ行(親)も外からは畳ませない
  assert.notEqual(externalCloseRefusal({ agentId: "parent01", rows, sideOf }), null);
  // 司令塔の印が付いた行も断る
  assert.notEqual(externalCloseRefusal({ agentId: "hub00001", rows, sideOf }), null);
  // 普通の子スレは従来どおりアーカイブできる(道を塞がない)
  assert.equal(externalCloseRefusal({ agentId: "plain001", rows, sideOf }), null);
});

test("送る文面は閉じたいスレ自身にスキルを走らせ、相手IDを明記する", () => {
  const text = handoffClosePrompt({
    sourceAgentId: "self0001aaaa",
    targetAgentId: "target02bbbb",
    targetTitle: "子司令塔",
    handoffPath: "/tmp/handoff.md",
  });
  assert.match(text, /handoff-and-close/);
  assert.match(text, /run --target target02bbbb --handoff \/tmp\/handoff\.md --execute/);
  assert.match(text, /自分以外のスレを閉じないこと/);
  // 短いIDでも宛先を取り違えないよう、本文に相手のIDをそのまま書く
  assert.match(text, /target02/);
});
