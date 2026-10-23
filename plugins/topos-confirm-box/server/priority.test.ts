import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LEDGER_FILE, normalizeProjects, readLedger } from "./priority.js";

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
