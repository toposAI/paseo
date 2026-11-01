/** 出口レビュー1R(2026-11-01)の指摘1・2・3を押さえる試験。
 *
 * - 指摘1: `finish` は失敗でも JSON を出す。JSON が読めたことを成功と取り違えない。
 * - 指摘2: 本文が作り直された後の古い行からの押下は、同じ cardId でも `stale` で弾く。
 * - 指摘3: カードの無い件は、機械が `consult --no-answer` で裏方へ回す(最大3回)。
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { answerCard, autoAskOnce, holdCard, type ShowDeps } from "./card-direct.js";

/** 偽の判断 CLI。呼ばれた引数を log に書き、環境の `FAKE_EXIT` / `FAKE_JSON` のとおりに答える。 */
function fakeCli(dir: string): ShowDeps["cli"] {
  const script = path.join(dir, "fake.js");
  writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, process.argv.slice(2).join(" ") + "\\n");`,
      'process.stdout.write((process.env.FAKE_JSON || "{}") + "\\n");',
      'const per = process.env["FAKE_" + String(process.argv[2] || "").toUpperCase() + "_EXIT"];',
      "process.exit(Number(per || process.env.FAKE_EXIT || 0));",
    ].join("\n"),
    "utf8",
  );
  return { python: process.execPath, script };
}

function deps(dir: string, env: NodeJS.ProcessEnv = {}): ShowDeps {
  return {
    // この試験では行を貼らない道だけを見る(呼ばれたら試験を落とす)
    paseo: {
      agents: {
        ref: () => {
          throw new Error("paseo は使わない");
        },
      },
    } as unknown as ShowDeps["paseo"],
    cli: fakeCli(dir),
    stateDir: dir,
    // 判断状態も一時ディレクトリへ向ける(本物の PAUSED.json を読まない)
    env: {
      TOPOS_CARD_DIRECT_AGENT_A: "agent-a",
      TOPOS_JUDGMENT_WINDOW_DIR: dir,
      ...env,
    } as NodeJS.ProcessEnv,
  };
}

function setupRow(dir: string, cardId = "j-1", shownAt = 111) {
  const cards = path.join(dir, "cards");
  mkdirSync(cards, { recursive: true });
  const cardFile = path.join(cards, `${cardId}.json`);
  writeFileSync(
    cardFile,
    '{"id":"j-1","question":"どれ?","options":[{"id":"a","label":"a案"}]}',
    "utf8",
  );
  const sha = createHash("sha1").update(readFileSync(cardFile)).digest("hex");
  writeFileSync(
    path.join(dir, "card_direct_rows.json"),
    JSON.stringify({
      agents: {
        "agent-a": {
          cardId,
          window: "A",
          shownAt,
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
  return { sha, cardId, shownAt };
}

function calls(dir: string): string[] {
  const file = path.join(dir, "calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

test("finish が失敗の JSON を出したときは成功にせず、回答済みの印も付けない", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  const { cardId, shownAt } = setupRow(dir);
  process.env.FAKE_JSON = '{"status":"not_open","why":"他で答え済み"}';
  process.env.FAKE_EXIT = "6";
  try {
    const out = await answerCard(deps(dir), {
      agentId: "agent-a",
      cardId,
      choiceId: "a",
      answer: "a案",
      shownAt,
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^finish_failed/);
    const state = JSON.parse(readFileSync(path.join(dir, "card_direct_rows.json"), "utf8"));
    assert.deepEqual(state.agents["agent-a"].answered, {});
  } finally {
    delete process.env.FAKE_JSON;
    delete process.env.FAKE_EXIT;
  }
});

test("JSON は出たが status が記録を表さないときも成功にしない", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  const { cardId, shownAt } = setupRow(dir);
  process.env.FAKE_JSON = '{"status":"empty"}';
  process.env.FAKE_EXIT = "0";
  try {
    const out = await answerCard(deps(dir), {
      agentId: "agent-a",
      cardId,
      choiceId: "a",
      answer: "a案",
      shownAt,
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^not_recorded: empty/);
  } finally {
    delete process.env.FAKE_JSON;
    delete process.env.FAKE_EXIT;
  }
});

test("記録できたときだけ回答済みにする", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  const { cardId, shownAt } = setupRow(dir);
  process.env.FAKE_JSON = '{"status":"queued","id":"j-1"}';
  process.env.FAKE_EXIT = "0";
  try {
    const out = await answerCard(deps(dir), {
      agentId: "agent-a",
      cardId,
      choiceId: "a",
      answer: "a案",
      shownAt,
    });
    assert.equal(out.ok, true);
    const state = JSON.parse(readFileSync(path.join(dir, "card_direct_rows.json"), "utf8"));
    assert.equal(state.agents["agent-a"].answered["j-1"].choiceId, "a");
  } finally {
    delete process.env.FAKE_JSON;
    delete process.env.FAKE_EXIT;
  }
});

test("別の時刻に出した行(showing が違う)からの押下は stale で CLI を呼ばない", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  const { cardId } = setupRow(dir, "j-1", 222);
  const out = await answerCard(deps(dir), {
    agentId: "agent-a",
    cardId,
    choiceId: "a",
    answer: "a案",
    shownAt: 111,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "stale");
  assert.deepEqual(calls(dir), []);
});

test("差し替えで止めた行からの押下も stale", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  const { cardId, shownAt } = setupRow(dir);
  const state = JSON.parse(readFileSync(path.join(dir, "card_direct_rows.json"), "utf8"));
  state.agents["agent-a"].retired = [shownAt];
  writeFileSync(path.join(dir, "card_direct_rows.json"), JSON.stringify(state), "utf8");
  const out = await answerCard(deps(dir), {
    agentId: "agent-a",
    cardId,
    choiceId: "a",
    answer: "a案",
    shownAt,
  });
  assert.equal(out.reason, "stale");
});

test("保留も、古い行からの押下は stale", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  const { cardId, shownAt } = setupRow(dir);
  const out = await holdCard(deps(dir), { agentId: "agent-a", cardId, shownAt: shownAt + 1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "stale");
  assert.deepEqual(calls(dir), []);
});

test("カードの無い件は consult --no-answer で裏方へ回す(失敗しても最大3回)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  process.env.FAKE_JSON = '{"id":"j-x","has_card":false,"card_note":"カード作成中"}';
  process.env.FAKE_EXIT = "0";
  process.env.FAKE_CONSULT_EXIT = "1";
  try {
    for (let i = 0; i < 5; i += 1) await autoAskOnce(deps(dir));
    const consult = calls(dir).filter((c) => c.startsWith("consult "));
    assert.equal(consult.length, 3);
    assert.equal(consult[0], "consult --window A --id j-x --no-answer");
  } finally {
    delete process.env.FAKE_JSON;
    delete process.env.FAKE_EXIT;
    delete process.env.FAKE_CONSULT_EXIT;
  }
});

test("consult が通れば、その件では二度と呼ばない", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-answer-"));
  process.env.FAKE_JSON = '{"id":"j-x","has_card":false}';
  process.env.FAKE_EXIT = "0";
  try {
    await autoAskOnce(deps(dir));
    await autoAskOnce(deps(dir));
    const consult = calls(dir).filter((c) => c.startsWith("consult "));
    assert.equal(consult.length, 1);
  } finally {
    delete process.env.FAKE_JSON;
    delete process.env.FAKE_EXIT;
  }
});
