/** 再起動後(判断カードの行が1本も無い状態)でも、`count` のハンドラが呼ばれれば自動出題が始まる試験。
 *
 * 本物の判断窓口の状態ディレクトリ・本物の CLI には触れない(すべて一時ディレクトリへ向ける)。
 * 自動出題は始まって3秒後に1回目の見回りで `next --window A` を打つので、その回数で「始まった数」を数える。
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type Handler = (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>;

test("行が無くても count ハンドラで自動出題が始まり、2回呼んでも1つだけ", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoask-start-"));
  const cliDir = path.join(dir, "cli");
  mkdirSync(path.join(cliDir, "antigravity", "utils"), { recursive: true });
  const log = path.join(dir, "calls.log");
  // 偽の判断 CLI(node で動く CommonJS)。呼ばれた引数を log に足し、空の JSON を返す。
  writeFileSync(
    path.join(cliDir, "antigravity", "utils", "judgment_window.py"),
    [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`,
      'process.stdout.write("{}\\n");',
    ].join("\n"),
    "utf8",
  );
  const stateDir = path.join(dir, "state");
  mkdirSync(path.join(stateDir, "windows"), { recursive: true });
  process.env.TOPOS_JUDGMENT_WINDOW_DIR = stateDir; // 行(rows)も PAUSED も無い空の状態
  process.env.TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR = cliDir;
  process.env.TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON = process.execPath;
  // count が通る読み取り先も一時ディレクトリへ向ける(確認箱・Vault・報告)
  process.env.TOPOS_CONFIRM_BOX_DIR = path.join(dir, "box");
  process.env.TOPOS_CONFIRM_BOX_VAULT_SOURCE = "0";
  process.env.TOPOS_FEEDBACK_DIRS = path.join(dir, "feedback");
  process.env.TOPOS_CARD_DIRECT_AGENT_A = "aaaaaaaa-0000-0000-0000-000000000000";

  const handlers = new Map<unknown, Handler>();
  const server = { handle: (rpc: unknown, h: Handler) => void handlers.set(rpc, h) };
  const { default: contribute } = await import("../index.server.js");
  contribute(server as never);
  const { confirmBoxCountRpc } = await import("../shared/contract.js");
  const count = handlers.get(confirmBoxCountRpc);
  assert.ok(count, "count ハンドラが登録されている");

  const paseo = {
    agents: { ref: () => ({ timeline: { refetch: async () => ({ entries: [] }) } }) },
  };
  // 呼ぶ前は何も始まっていない
  await new Promise((r) => setTimeout(r, 3_600));
  assert.equal(existsSync(log), false);

  // count 自体が失敗しても(Vault などが無い環境)自動出題の開始は済んでいる
  await count!({}, { paseo }).catch(() => undefined);
  await count!({}, { paseo }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4_000));

  const nextCalls = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("next --window A"));
  assert.equal(nextCalls.length, 1, "見回りは1つだけ(2回呼んでも二重に始まらない)");
});
