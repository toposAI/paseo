// 確認箱バッジ(readVaultDecisions)と判断窓口A(Python judgment_window.open_notes)が同じノート集合を数えることの
// 契約テスト(TS側)。正解は ToposAI-Mini-Project の fixtures/judgment_badge_contract/expected.json の1か所だけ
// (Python側 tests/test_judgment_badge_contract.py も同じファイルを読む)。リポジトリが無い環境では skip。
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { readVaultDecisions } from "./vault-decisions.js";

const FIX =
  process.env.TOPOS_BADGE_CONTRACT_DIR ??
  "/Users/user/repos/ToposAI-Mini-Project/antigravity/utils/tests/fixtures/judgment_badge_contract";

test("バッジが数える open ノートは窓口A(Python)の正解と一致する", { skip: !fs.existsSync(FIX) }, () => {
  const expected = (
    JSON.parse(fs.readFileSync(`${FIX}/expected.json`, "utf8")) as { open: string[] }
  ).open.toSorted();
  const read = readVaultDecisions({ TOPOS_CONFIRM_BOX_DECISION_NOTE_DIR: FIX } as NodeJS.ProcessEnv);
  assert.equal(read.error, null);
  const got = read.items.map((i) => (i.key ?? "").replace(/^vault:/, "")).toSorted();
  assert.deepEqual(got, expected);
});
