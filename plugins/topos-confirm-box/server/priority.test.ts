import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveProject,
  LEDGER_FILE,
  moveProject,
  normalizeProjects,
  readLedger,
  splitArchived,
} from "./priority.js";

const proj = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `p${i}`,
  name: `P${i}`,
  note: "",
  ...extra,
});

test("件数で切らない(2026-10-23: 11件目以降が消える不具合の再発防止)", () => {
  const raw = Array.from({ length: 25 }, (_, i) => proj(i));
  const out = normalizeProjects(raw);
  assert.equal(out?.length, 25);
  assert.equal(out?.[24].id, "p24");
});

test("thread は残す。未設定・空・非文字列は null", () => {
  const out = normalizeProjects([
    proj(1, { thread: "  agent-1 " }),
    proj(2, { thread: null }),
    proj(3, { thread: "" }),
    proj(4, { thread: 42 }),
    proj(5),
  ]);
  assert.deepEqual(
    out?.map((p) => p.thread),
    ["agent-1", null, null, null, null],
  );
});

test("未知のフィールドは捨て、id の無い行・重複は落とす", () => {
  const out = normalizeProjects([
    { ...proj(1), extra: "x" },
    { name: "no id" },
    proj(1),
    { id: "  ", name: "blank" },
  ]);
  assert.equal(out?.length, 1);
  assert.deepEqual(Object.keys(out?.[0] ?? {}).sort(), ["id", "name", "note", "thread"]);
});

test("空・非配列は null(初期値へ落とす側で判断)", () => {
  assert.equal(normalizeProjects([]), null);
  assert.equal(normalizeProjects(null), null);
  assert.equal(normalizeProjects({ projects: [] }), null);
});

test("並べ替えの書き戻し(読み直して正規化)で thread が消えない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-"));
  try {
    fs.writeFileSync(
      path.join(dir, LEDGER_FILE),
      JSON.stringify({
        version: 1,
        updated_ts: 1,
        projects: [proj(1, { thread: "agent-1" }), proj(2, { thread: "agent-2" })],
      }),
    );
    const { projects } = readLedger(dir);
    assert.deepEqual(
      projects.map((p) => p.thread),
      ["agent-1", "agent-2"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("自動追加の印: new は isNew に写り、動かすと台帳から new が外れ auto/thread は残る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-"));
  try {
    fs.writeFileSync(
      path.join(dir, LEDGER_FILE),
      JSON.stringify({
        version: 1,
        updated_ts: 1,
        projects: [
          proj(1),
          proj(2, { thread: "agent-2", auto: true, new: true }),
          proj(3, { thread: "agent-3", auto: true, new: true }),
        ],
      }),
    );
    const before = readLedger(dir).projects;
    assert.deepEqual(
      before.map((p) => p.isNew === true),
      [false, true, true],
    );
    assert.equal(moveProject(dir, "p3", 1).ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LEDGER_FILE), "utf-8"));
    const [first, , last] = raw.projects;
    assert.equal(first.id, "p3");
    assert.equal(first.new, undefined);
    assert.equal(first.auto, true);
    assert.equal(first.thread, "agent-3");
    assert.equal(last.id, "p2");
    assert.equal(last.new, true); // 動かしていない行の印は残る
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("アーカイブ: 印だけ付けて台帳には残り、一覧から外れ、戻せる。並べ替えは見えている行の順位で効く", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-"));
  try {
    fs.writeFileSync(
      path.join(dir, LEDGER_FILE),
      JSON.stringify({ version: 1, updated_ts: 1, projects: [proj(1), proj(2), proj(3), proj(4)] }),
    );
    assert.equal(archiveProject(dir, "p2", true).ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LEDGER_FILE), "utf-8"));
    assert.equal(raw.projects.length, 4); // 消えない
    assert.equal(raw.projects[1].archived, true);
    assert.equal(raw.projects[1].archived_by, "ui");
    const { visible, archived } = splitArchived(readLedger(dir).projects);
    assert.deepEqual(visible.map((p) => p.id), ["p1", "p3", "p4"]);
    assert.deepEqual(archived.map((p) => p.id), ["p2"]);
    // 見えている行で 3 位の p4 を 1 位へ → 画面上は p4,p1,p3。アーカイブ済み p2 は添字1のまま
    assert.equal(moveProject(dir, "p4", 1).ok, true);
    const after = readLedger(dir).projects;
    assert.deepEqual(splitArchived(after).visible.map((p) => p.id), ["p4", "p1", "p3"]);
    assert.equal(after.find((p) => p.id === "p2")?.archived, true);
    // 戻す: 一覧の末尾へ・印が外れる
    assert.equal(archiveProject(dir, "p2", false).ok, true);
    const back = splitArchived(readLedger(dir).projects);
    assert.deepEqual(back.visible.map((p) => p.id), ["p4", "p1", "p3", "p2"]);
    assert.equal(back.archived.length, 0);
    // 履歴に変更前が残る(戻す用)
    const hist = fs.readFileSync(path.join(dir, "priority_ledger_history.jsonl"), "utf-8").trim().split("\n");
    assert.equal(hist.length, 3);
    assert.equal(archiveProject(dir, "nope", true).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
