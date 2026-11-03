import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  coordinatorCandidates,
  isUsableAgentId,
  pickCoordinatorTarget,
} from "../shared/card-pane.js";
import { readFallbackCoordinatorIds } from "./coordinator-threads.js";

/**
 * 確認箱チャットの振り替え先(2026-11-03 ユーザー報告「確認箱からチャットしようとしてもできない」)。
 *
 * 総司令塔(general)は 2026-10-26 に退役し、`domains/general/coordinator_id` はアーカイブ済みの
 * スレを指したまま。これを唯一の宛先にすると、投函元スレを持たないカードのチャットが
 * 「総司令塔も閉じています(送信できません)」で止まる。後継(裏方1)を候補に足し、
 * 端末が生死を見て生きている先を選ぶことを固定する。
 */

function stateDirs(): { stateDir: string; parent: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "coord-fallback-"));
  return { stateDir: path.join(parent, "coordinator_wakeup_daemon"), parent };
}

test("振り替え先の候補は「総司令塔 → 後継の裏方1」の順で重複を畳む", () => {
  const { stateDir, parent } = stateDirs();
  fs.mkdirSync(path.join(stateDir, "domains", "general"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "domains", "general", "coordinator_id"),
    "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49\n",
  );
  fs.mkdirSync(path.join(parent, "backoffice"), { recursive: true });
  fs.writeFileSync(
    path.join(parent, "backoffice", "coordinator_id"),
    "f6dac08b-ca32-4a06-b105-0b89e3088166\n",
  );
  assert.deepEqual(readFallbackCoordinatorIds(stateDir), [
    "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49",
    "f6dac08b-ca32-4a06-b105-0b89e3088166",
  ]);
});

test("同じIDが総司令塔と裏方で重複しても1本・壊れた値は落とす", () => {
  const { stateDir, parent } = stateDirs();
  const id = "f6dac08b-ca32-4a06-b105-0b89e3088166";
  fs.mkdirSync(path.join(stateDir, "domains", "general"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "domains", "general", "coordinator_id"), `${id}\n`);
  fs.mkdirSync(path.join(parent, "backoffice"), { recursive: true });
  fs.writeFileSync(path.join(parent, "backoffice", "coordinator_id"), `${id}\n`);
  assert.deepEqual(readFallbackCoordinatorIds(stateDir), [id]);

  fs.writeFileSync(path.join(parent, "backoffice", "coordinator_id"), "../../etc/passwd\n");
  assert.deepEqual(readFallbackCoordinatorIds(stateDir), [id]);
});

test("状態ファイルが無ければ空(例外を投げない)", () => {
  const { stateDir } = stateDirs();
  assert.deepEqual(readFallbackCoordinatorIds(stateDir), []);
});

test("候補の並びは空を落として順序を保つ", () => {
  assert.deepEqual(coordinatorCandidates("a", ["b", "a", "", " c "]), ["a", "b", "c"]);
  assert.deepEqual(coordinatorCandidates(null, []), []);
  assert.deepEqual(coordinatorCandidates(" a ", undefined), ["a"]);
});

test("生きている先を選ぶ。総司令塔が閉じていれば後継へ送る", () => {
  assert.equal(
    pickCoordinatorTarget([
      { id: "retired", live: false },
      { id: "backstage", live: true },
    ]),
    "backstage",
  );
  // 生きている先が先頭ならそちら(従来どおり)
  assert.equal(
    pickCoordinatorTarget([
      { id: "general", live: true },
      { id: "backstage", live: false },
    ]),
    "general",
  );
});

test("宛先に使えるのは完全なUUIDだけ(短縮IDは振り替え側へ倒す)", () => {
  assert.equal(isUsableAgentId("1af1a9b"), false);
  assert.equal(isUsableAgentId("1800e2f7-63a5-40b7-9f5f-52e0ba24bb49"), true);
  assert.equal(isUsableAgentId("1800e2f7-63a5-40b7"), false);
  assert.equal(isUsableAgentId(""), false);
  assert.equal(isUsableAgentId(null), false);
});

test("生死が読めない(null)は最後の手段にし、全部閉じていれば null", () => {
  assert.equal(
    pickCoordinatorTarget([
      { id: "retired", live: false },
      { id: "unknown", live: null },
    ]),
    "unknown",
  );
  assert.equal(
    pickCoordinatorTarget([
      { id: "retired", live: false },
      { id: "backstage", live: false },
    ]),
    null,
  );
  assert.equal(pickCoordinatorTarget([]), null);
});
