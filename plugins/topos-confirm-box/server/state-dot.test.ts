/**
 * 点の判定・色・明暗の判定(純正 Paseo と同じ意味にする部分)。
 * ここが崩れると「承認待ちが見つからない」「暗い背景で点が読めない」に直結するので固定する。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  STATE_DOT_COLORS,
  STATE_DOT_DONE_OPACITY,
  STATE_DOT_KINDS,
  STATE_DOT_SIZE,
  appearanceOf,
  deriveStateDot,
  stateDotStyle,
} from "../shared/state-dot.js";
import { buildUpperRows, dotOf, shouldShowDot } from "../shared/sidebar-rows.js";
import type { RowThread } from "../shared/sidebar-rows.js";

/** WCAG のコントラスト比。 */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = Number.parseInt(hex.replace("#", ""), 16);
    const ch = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch((n >> 16) & 0xff) + 0.7152 * ch((n >> 8) & 0xff) + 0.0722 * ch(n & 0xff);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("判定の優先順: 承認待ち > 失敗 > 実行中 > 新着 > 待機", () => {
  // 承認待ちは status が running のままでも出る(ここが本命。2026-10-24 ユーザー依頼)
  assert.equal(
    deriveStateDot({
      machineState: "running",
      pendingPermissionCount: 1,
      requiresAttention: true,
    }),
    "needs_input",
  );
  // pendingPermissions が空でも attentionReason=permission なら承認待ち
  assert.equal(
    deriveStateDot({ machineState: "idle", attentionReason: "permission" }),
    "needs_input",
  );
  // 承認待ちは失敗より優先(止まっている理由を先に見せる)
  assert.equal(deriveStateDot({ machineState: "error", pendingPermissionCount: 2 }), "needs_input");
  assert.equal(deriveStateDot({ machineState: "error" }), "failed");
  assert.equal(deriveStateDot({ machineState: "idle", attentionReason: "error" }), "failed");
  // initializing も実行中として見せる(純正は起動中の輪を出す)
  assert.equal(deriveStateDot({ machineState: "initializing" }), "running");
  assert.equal(deriveStateDot({ machineState: "running" }), "running");
  assert.equal(deriveStateDot({ machineState: "idle", requiresAttention: true }), "attention");
  assert.equal(deriveStateDot({ machineState: "idle" }), "done");
  assert.equal(deriveStateDot({ machineState: null }), "done");
});

test("点の色は明暗それぞれで背景に対して 3:1 以上(逆のパレットを選ぶと 3:1 を割る)", () => {
  const LIGHT_BG = "#f4f4f5";
  const DARK_BG = "#141716";
  for (const kind of STATE_DOT_KINDS) {
    if (kind === "done") continue;
    const light = STATE_DOT_COLORS.light[kind];
    const dark = STATE_DOT_COLORS.dark[kind];
    assert.ok(contrast(light, LIGHT_BG) >= 3, `light/${kind} のコントラストが不足`);
    assert.ok(contrast(dark, DARK_BG) >= 3, `dark/${kind} のコントラストが不足`);
    // 暗いパレットを明るい背景へ置くと 3:1 を割る(明暗判定が要る理由の固定)
    assert.ok(contrast(dark, LIGHT_BG) < 3, `dark/${kind} を明るい背景で使えてしまう`);
    // 暗い背景では明るいパレットでも 3:1 を割らない(純正の値そのまま。劣化はするが読める)
    assert.ok(contrast(light, DARK_BG) >= 3);
  }
});

test("明暗は背景の輝度で決める(判定できない色は light)", () => {
  assert.equal(appearanceOf("#f4f4f5"), "light");
  assert.equal(appearanceOf("#ffffff"), "light");
  assert.equal(appearanceOf("#141716"), "dark");
  assert.equal(appearanceOf(undefined), "light");
  assert.equal(appearanceOf("not-a-color"), "light");
});

test("承認待ちの点は他の状態より大きい(done は小さい)", () => {
  const sizes = STATE_DOT_SIZE;
  assert.ok(sizes.needs_input > sizes.running);
  assert.ok(sizes.running > sizes.done);
  assert.ok(STATE_DOT_DONE_OPACITY < 1);
});

test("点の描き方: done だけ色を持たず、渡された文字色を薄く使う", () => {
  const waiting = stateDotStyle("needs_input", "light");
  assert.equal(waiting.color, STATE_DOT_COLORS.light.needs_input);
  assert.equal(waiting.opacity, 1);
  assert.equal(waiting.size, STATE_DOT_SIZE.needs_input);
  assert.equal(stateDotStyle("needs_input", "dark").color, STATE_DOT_COLORS.dark.needs_input);
  const done = stateDotStyle("done", "light");
  assert.equal(done.color, null);
  assert.equal(done.opacity, STATE_DOT_DONE_OPACITY);
});

function thread(over: Partial<RowThread> = {}): RowThread {
  return { agentId: "a", title: "スレ", status: "実装中", ...over };
}

test("子スレ行は点を出す(材料が無い行は出さない)", () => {
  assert.equal(dotOf(thread({ stateDot: "needs_input" })), "needs_input");
  assert.equal(dotOf(thread({ stateDot: "done" })), "done");
  assert.equal(dotOf(thread({ stateDot: null })), null);
  assert.equal(dotOf(thread()), null);
});

test("司令塔の行は承認待ち/失敗のときだけ点を出す", () => {
  assert.equal(dotOf(thread({ coordinator: true, stateDot: "needs_input" })), "needs_input");
  assert.equal(dotOf(thread({ coordinator: true, stateDot: "failed" })), "failed");
  assert.equal(dotOf(thread({ coordinator: true, stateDot: "running" })), null);
  assert.equal(dotOf(thread({ coordinator: true, stateDot: "done" })), null);
  assert.equal(shouldShowDot(thread({ coordinator: true, stateDot: "attention" })), false);
  // 子スレ(coordinator でない)は done でも出す(点が無い=止まっていない、と読ませない)
  assert.equal(shouldShowDot(thread({ stateDot: "done" })), true);
});

test("上段の行に点が載る(ノートの有無どちらの分岐でも)", () => {
  const rows = buildUpperRows(
    [
      thread({ agentId: "no-note", stateDot: "needs_input" }),
      thread({ agentId: "with-note", stateDot: "attention" }),
    ],
    new Map([
      [
        "with-note",
        {
          path: "/vault/x.md",
          kind: "implementation" as const,
          slug: "x",
          title: "ノートの題名",
          status: "実装中" as const,
          conclusion: "",
          threadId: "with-note",
          threadCandidates: [],
          conceptLinks: [],
          zone: "active",
          updatedAt: 1,
        },
      ],
    ]),
  );
  const byId = new Map(rows.map((r) => [r.thread.agentId, r.dot]));
  assert.equal(byId.get("no-note"), "needs_input");
  assert.equal(byId.get("with-note"), "attention");
});
