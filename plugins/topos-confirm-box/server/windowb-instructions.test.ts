/**
 * 窓口Bの「指示の一覧」を Python から引く係。呼び方・キャッシュ・読めないときの扱いだけを見る
 * (どの指示がどの状態かの判断は Python 側のテストで見る)。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedWindowBRunner,
  resolveWindowBRunner,
  type WindowBRunner,
} from "./windowb-instructions.js";

/** 偽の python: 出力を固定し、渡された引数を argv.log へ書き出す。
 * 出力は `printf '%s' '<base64>' | base64 -d` で出して、本文の改行・引用符をそのまま通す。 */
function fakePython(body: string): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  const script = path.join(dir, "python3");
  const log = path.join(dir, "argv.log");
  const encoded = Buffer.from(body, "utf8").toString("base64");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${JSON.stringify(log)}\nprintf '%s' ${encoded} | base64 -d\n`,
    { mode: 0o755 },
  );
  return { dir, log };
}

/** 偽のチェックアウト(中に antigravity/utils/window_b_instruction_panel.py がある形)。 */
function fakeCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbco-"));
  fs.mkdirSync(path.join(dir, "antigravity", "utils"), { recursive: true });
  fs.writeFileSync(path.join(dir, "antigravity", "utils", "window_b_instruction_panel.py"), "");
  return dir;
}

const EMPTY = {
  generatedAt: 1,
  ledgerUpdatedAt: 0,
  total: 0,
  items: [],
  counts: {},
  alerts: 0,
  warns: 0,
  notices: [],
};

test("スクリプトが無ければ呼んだときに、探したパスつきで失敗する(起動時に固定しない)", async () => {
  const runner = resolveWindowBRunner({ TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: "/nonexistent" });
  await assert.rejects(
    () => runner(40),
    /スクリプトがありません\(\/nonexistent\/antigravity\/utils\/window_b_instruction_panel\.py\)/,
  );
});

test("--limit を渡し、最後の行の JSON を読む(前に警告が出ても壊れない)", async () => {
  const checkout = fakeCheckout();
  const py = fakePython(`warning: something\n${JSON.stringify(EMPTY)}\n# end`);
  const runner = resolveWindowBRunner({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: checkout,
    TOPOS_WINDOWB_PANEL_PYTHON: path.join(py.dir, "python3"),
  });
  assert.deepEqual(await runner(40), EMPTY);
  const argv = fs.readFileSync(py.log, "utf8").trim().split("\n");
  // 1つ目は流すスクリプト(チェックアウト側)、そのあとが引数
  assert.equal(
    argv[0],
    path.join(checkout, "antigravity", "utils", "window_b_instruction_panel.py"),
  );
  assert.deepEqual(argv.slice(1), ["--limit", "40"]);
});

test("読めない出力は失敗として投げる(0件に丸めない)", async () => {
  const checkout = fakeCheckout();
  const py = fakePython("not json");
  const runner = resolveWindowBRunner({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: checkout,
    TOPOS_WINDOWB_PANEL_PYTHON: path.join(py.dir, "python3"),
  });
  await assert.rejects(() => runner(40));
});

test("短い間は同じ結果を返し、同じ上限の同時呼び出しは1回にまとめる", async () => {
  let calls = 0;
  let clock = 1_000;
  const runner: WindowBRunner = async () => {
    calls += 1;
    return { ...EMPTY, total: calls };
  };
  const cached = cachedWindowBRunner(runner, 8_000, () => clock);
  // 同時に2回 → python は1回
  const [a, b] = await Promise.all([cached(40), cached(40)]);
  assert.equal(a.total, 1);
  assert.equal(b.total, 1);
  assert.equal(calls, 1);
  // キャッシュ内 → 呼ばない
  assert.equal((await cached(40)).total, 1);
  assert.equal(calls, 1);
  // 期限切れ → 呼ぶ
  clock += 8_001;
  assert.equal((await cached(40)).total, 2);
  assert.equal(calls, 2);
  // 上限が違えば別のキー
  assert.equal((await cached(10)).total, 3);
  assert.equal(calls, 3);
});
