/** 確認箱のカードからの発言を、投函元へすぐ送らず受け箱へ溜める入口の試験(2026-11-08)。
 *
 * - 溜まった(終了0)ときだけ true=画面は送らない。
 * - 溜められない(終了1・起動失敗・置き場なし)ときは false=画面は従来どおり今すぐ送る。
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueueFromPane, resolveEnqueueCli } from "./card-direct.js";

/** 偽の溜める入口(名前は本物と同じ .py。中身は node で走る JS)。呼ばれた引数と本文を残す。 */
function fakeCli(
  dir: string,
  exitCode: number,
): { env: NodeJS.ProcessEnv; log: string; body: string } {
  const scripts = path.join(dir, "scripts");
  mkdirSync(scripts, { recursive: true });
  const log = path.join(dir, "calls.log");
  const body = path.join(dir, "stdin.txt");
  writeFileSync(
    path.join(scripts, "notify_digest_enqueue.py"),
    [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join("\\n") + "\\n--\\n");`,
      `fs.writeFileSync(${JSON.stringify(body)}, fs.readFileSync(0, "utf8"));`,
      `process.exit(${exitCode});`,
    ].join("\n"),
    "utf8",
  );
  return {
    env: {
      TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: dir,
      TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: process.execPath,
    },
    log,
    body,
  };
}

test("enqueueFromPane は溜まった(終了0)ときだけ true を返し、宛先と本文を渡す", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cb-enqueue-"));
  const fake = fakeCli(dir, 0);
  const ok = await enqueueFromPane({ dest: "agent-x", text: "この件は完了で" }, fake.env);
  assert.equal(ok, true);
  const args = readFileSync(fake.log, "utf8");
  // 送り元は confirm_box_chat 固定(受け箱の間隔を詰める側の目印)。本文は標準入力で渡す。
  assert.match(args, /--dest\nagent-x/);
  assert.match(args, /--caller\nconfirm_box_chat/);
  assert.equal(fake.body ? readFileSync(fake.body, "utf8") : "", "この件は完了で");
});

test("enqueueFromPane は溜められない(終了1)とき false を返す=画面は今すぐ送る", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cb-enqueue-"));
  const fake = fakeCli(dir, 1);
  assert.equal(await enqueueFromPane({ dest: "agent-x", text: "q" }, fake.env), false);
});

test("enqueueFromPane は入口が無い・空のとき false(呼び出しもしない)", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "cb-enqueue-"));
  assert.equal(resolveEnqueueCli({ TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: empty }), null);
  assert.equal(
    await enqueueFromPane(
      { dest: "agent-x", text: "q" },
      { TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: empty },
    ),
    false,
  );
  const fake = fakeCli(mkdtempSync(path.join(tmpdir(), "cb-enqueue-")), 0);
  assert.equal(await enqueueFromPane({ dest: "  ", text: "q" }, fake.env), false);
  assert.equal(await enqueueFromPane({ dest: "agent-x", text: "  " }, fake.env), false);
});
