/** 表示中の1問が後の発言の下に埋もれたときの出し直し(2026-11-02 ユーザー「また窓口Aバグってる。次が出てない」)。
 *
 * - 後に発言あり + idle = 一番下へ出し直し(古い行は退役)
 * - running = 出し直さない
 * - 自分が最後 = 出し直さない(繰り返さない)
 * - 退役した古い行の押下は拒否
 * 本物の判断状態・CLI・窓口Aには触れない(すべて一時ディレクトリと偽物)。
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { answerCard, autoAskOnce, type ShowDeps } from "./card-direct.js";

const CARD = { id: "j-1", question: "どれ?", options: [{ id: "a", label: "a案" }] };

function setup(status: string, entries: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "card-latest-"));
  const script = path.join(dir, "fake.js");
  writeFileSync(
    script,
    `process.stdout.write(${JSON.stringify(JSON.stringify({ id: "j-1", has_card: true, window: "A", card: CARD }))} + "\\n");`,
    "utf8",
  );
  mkdirSync(path.join(dir, "cards"), { recursive: true });
  const cardFile = path.join(dir, "cards", "j-1.json");
  writeFileSync(cardFile, JSON.stringify(CARD), "utf8");
  const sha = createHash("sha1").update(readFileSync(cardFile)).digest("hex");
  writeFileSync(
    path.join(dir, "card_direct_rows.json"),
    JSON.stringify({
      agents: {
        "agent-a": {
          cardId: "j-1",
          window: "A",
          shownAt: 111,
          cardSha: sha,
          options: [{ id: "a", label: "a案", description: "" }],
          answered: {},
          held: [],
          retired: [],
        },
      },
    }),
    "utf8",
  );
  const appended: unknown[] = [];
  const deps: ShowDeps = {
    paseo: {
      agents: {
        ref: () => ({
          status,
          refresh: async () => null,
          timeline: {
            refetch: async () => ({ entries }),
            append: async (item: unknown) => void appended.push(item),
          },
        }),
      },
    } as unknown as ShowDeps["paseo"],
    cli: { python: process.execPath, script },
    stateDir: dir,
    env: {
      TOPOS_CARD_DIRECT_AGENT_A: "agent-a",
      TOPOS_JUDGMENT_WINDOW_DIR: dir,
    } as NodeJS.ProcessEnv,
  };
  return { dir, deps, appended };
}

const cardRow = { item: { type: "plugin", kind: "topos-card-direct", data: { cardId: "j-1" } } };
const talk = { item: { type: "assistant_message", text: "返事" } };

function kindOk() {
  // CARD_DIRECT_KIND の実値を試験の偽データに合わせる
  return import("../shared/card-direct.js").then((m) => m.CARD_DIRECT_KIND);
}

async function rowFor(kind: string) {
  return { item: { ...cardRow.item, kind } };
}

test("後に発言があり idle のときは一番下へ出し直し、古い行は退役する", async () => {
  const kind = await kindOk();
  const { dir, deps, appended } = setup("idle", [await rowFor(kind), talk]);
  const res = await autoAskOnce(deps);
  assert.equal(res.shown, true);
  assert.equal(appended.length, 1);
  const state = JSON.parse(readFileSync(path.join(dir, "card_direct_rows.json"), "utf8"));
  assert.ok(state.agents["agent-a"].retired.includes(111), "古い行は退役");
  assert.notEqual(state.agents["agent-a"].shownAt, 111, "新しい行が有効");
});

test("窓口Aが running の間は出し直さない", async () => {
  const kind = await kindOk();
  const { deps, appended } = setup("running", [await rowFor(kind), talk]);
  const res = await autoAskOnce(deps);
  assert.equal(res.shown, false);
  assert.equal(appended.length, 0);
});

test("自分の行が最後なら出し直さない(繰り返さない)", async () => {
  const kind = await kindOk();
  const { deps, appended } = setup("idle", [talk, await rowFor(kind)]);
  const res = await autoAskOnce(deps);
  assert.equal(res.shown, false);
  assert.equal(appended.length, 0);
});

test("退役した古い行からの押下は拒否される", async () => {
  const kind = await kindOk();
  const { deps, dir } = setup("idle", [await rowFor(kind), talk]);
  await autoAskOnce(deps);
  const out = await answerCard(deps, {
    agentId: "agent-a",
    cardId: "j-1",
    choiceId: "a",
    answer: "a案",
    shownAt: 111,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "stale");
  const state = JSON.parse(readFileSync(path.join(dir, "card_direct_rows.json"), "utf8"));
  assert.deepEqual(state.agents["agent-a"].answered, {});
});
