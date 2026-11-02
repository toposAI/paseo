import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveProject,
  buildPriorityDetail,
  countRunning,
  resolveLiveThreads,
  LEDGER_FILE,
  markStanding,
  moveProject,
  normalizeProjects,
  readLedger,
  readMembershipRow,
  readOpenQuestions,
  sameName,
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
    assert.deepEqual(
      visible.map((p) => p.id),
      ["p1", "p3", "p4"],
    );
    assert.deepEqual(
      archived.map((p) => p.id),
      ["p2"],
    );
    // 見えている行で 3 位の p4 を 1 位へ → 画面上は p4,p1,p3。アーカイブ済み p2 は添字1のまま
    assert.equal(moveProject(dir, "p4", 1).ok, true);
    const after = readLedger(dir).projects;
    assert.deepEqual(
      splitArchived(after).visible.map((p) => p.id),
      ["p4", "p1", "p3"],
    );
    assert.equal(after.find((p) => p.id === "p2")?.archived, true);
    // 戻す: 一覧の末尾へ・印が外れる
    assert.equal(archiveProject(dir, "p2", false).ok, true);
    const back = splitArchived(readLedger(dir).projects);
    assert.deepEqual(
      back.visible.map((p) => p.id),
      ["p4", "p1", "p3", "p2"],
    );
    assert.equal(back.archived.length, 0);
    // 履歴に変更前が残る(戻す用)
    const hist = fs
      .readFileSync(path.join(dir, "priority_ledger_history.jsonl"), "utf-8")
      .trim()
      .split("\n");
    assert.equal(hist.length, 3);
    assert.equal(archiveProject(dir, "nope", true).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const th = (agentId: string, title: string, status = "実装中", machineState = "running") => ({
  agentId,
  title,
  status,
  machineState,
});

test("常時の方針: 一覧から外れて方針欄に移り、戻すと末尾に戻る。並べ替えは一覧の行だけを動かす", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-"));
  try {
    fs.writeFileSync(
      path.join(dir, LEDGER_FILE),
      JSON.stringify({
        version: 1,
        updated_ts: 1,
        projects: [proj(1), proj(2, { new: true }), proj(3)],
      }),
    );
    assert.equal(markStanding(dir, "p2", true).ok, true);
    // 方針へ移した時点で「新規(自動追加のまま)」の印は落ちる
    assert.equal(readLedger(dir).projects.find((p) => p.id === "p2")?.isNew, undefined);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LEDGER_FILE), "utf-8"));
    assert.equal(raw.projects.length, 3); // 消えない
    assert.equal(raw.projects.find((p: { id: string }) => p.id === "p2").standing, true);
    const s1 = splitArchived(readLedger(dir).projects);
    assert.deepEqual(
      s1.visible.map((p) => p.id),
      ["p1", "p3"],
    );
    assert.deepEqual(
      s1.standing.map((p) => p.id),
      ["p2"],
    );
    // 一覧の 2 位(p3)を 1 位へ。方針の p2 は消えず、一覧の順だけ変わる
    assert.equal(moveProject(dir, "p3", 1).ok, true);
    const s2 = splitArchived(readLedger(dir).projects);
    assert.deepEqual(
      s2.visible.map((p) => p.id),
      ["p3", "p1"],
    );
    assert.deepEqual(
      s2.standing.map((p) => p.id),
      ["p2"],
    );
    // 戻す: 一覧の末尾へ
    assert.equal(markStanding(dir, "p2", false).ok, true);
    const s3 = splitArchived(readLedger(dir).projects);
    assert.deepEqual(
      s3.visible.map((p) => p.id),
      ["p3", "p1", "p2"],
    );
    // 「新規」の印は、方針へ移す(人が触った)時点で落ちる。残すと担当スレが消えた時に自動で外される側へ戻る
    assert.equal(s3.visible.find((p) => p.id === "p2")?.isNew, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("常時の方針: 名前ではなく印だけで決める(印を外せば一覧に戻る)", () => {
  const rows = normalizeProjects([proj(1, { name: "トークン節約" }), proj(2, { standing: true })]);
  const { visible, standing } = splitArchived(rows ?? []);
  assert.deepEqual(
    visible.map((p) => p.id),
    ["p1"],
  );
  assert.deepEqual(
    standing.map((p) => p.id),
    ["p2"],
  );
});

test("動いている件数: 担当スレ・同じ題名の未完了を数え、完了・closed・待機は数えない", () => {
  const p = { id: "ep", name: "子スレ使い捨ての実装", note: "", thread: "a1", running: 0 };
  const threads = [
    th("a1", "子スレ使い捨ての実装"),
    th("b2", "子スレ使い捨ての実装 (2本目)"),
    th("c3", "子スレ使い捨ての実装", "完了"),
    th("d4", "子スレ使い捨ての実装", "実装中", "closed"),
    th("e5", "子スレ使い捨ての実装", "待機"),
    th("f6", "関係ない案件"),
  ];
  assert.equal(countRunning(p, threads), 2);
  assert.equal(sameName("F-80(逐語ゲート・出典)", "F-80（逐語ゲート・出典）"), true);
});

test("中身: 説明・担当スレ・題名が同じほかの子スレ(生きている順)を返す", () => {
  const p = { id: "x", name: "子スレ切替禁止の機械化", note: "21:22 ユーザー指示", thread: "t1" };
  const threads = [
    th("t0", "子スレ切替禁止の機械化", "完了"),
    th("t1", "子スレ切替禁止の機械化"),
    th("t2", "ほかの案件"),
  ];
  const d = buildPriorityDetail(p, threads, []);
  assert.equal(d.note, "21:22 ユーザー指示");
  assert.equal(d.thread?.agentId, "t1");
  assert.deepEqual(
    d.related.map((t) => t.agentId),
    ["t0"],
  );
});

test("中身: 未決の判断は project 名で突き合わせ、判断済み(approve/decide)は数えない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-"));
  try {
    const lines = [
      { t: "item", id: "i1", ts: 1, project: "開発の優先順位", subject: "残っている判断" },
      { t: "item", id: "i2", ts: 2, project: "開発の優先順位", subject: "もう決めた" },
      { t: "ack", id: "i2", ts: 3, action: "approve" },
      { t: "item", id: "i3", ts: 4, project: "別の件", subject: "関係ない" },
      { t: "item", id: "i4", ts: 5, project: "開発の優先順位", subject: "決定イベントで閉じた" },
      { t: "decide", id: "i4", ts: 6 },
    ];
    fs.writeFileSync(
      path.join(dir, "events-202610.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n"),
    );
    const q = readOpenQuestions(dir, "開発の優先順位");
    assert.deepEqual(
      q.map((x) => x.id),
      ["i1"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("束ね: 横の台帳の threads と題名キーワードも担当に数え、中身にも並べる(thread だけの行は従来どおり)", () => {
  const p = { id: "fam", name: "Topos家族版(UI・配布)", note: "", thread: null };
  const mem = { keywords: ["家族版"], threads: ["g1"] };
  const threads = [
    th("g1", "孫スレの題名は無関係"),
    th("k1", "家族版の画面修正"),
    th("k2", "家族版の出荷", "完了"),
    th("o1", "ほかの案件"),
  ];
  assert.equal(countRunning(p, threads, mem), 2);
  assert.equal(countRunning(p, threads), 0); // 束ねなし=従来どおり
  const d = buildPriorityDetail(p, threads, [], mem);
  assert.deepEqual(d.related.map((t) => t.agentId).sort(), ["g1", "k1", "k2"]);
  // thread だけの行
  const q = { id: "q", name: "単発", note: "", thread: "g1" };
  assert.equal(countRunning(q, threads, null), 1);
});

test("横の台帳の読み込み: 行が無い・ファイルが無いときは null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  assert.equal(readMembershipRow(dir, "a"), null);
  fs.writeFileSync(
    path.join(dir, "priority_membership.json"),
    JSON.stringify({ version: 1, rows: { a: { keywords: ["x"], threads: ["t", 3] } } }),
  );
  assert.deepEqual(readMembershipRow(dir, "a"), { keywords: ["x"], threads: ["t"] });
  assert.equal(readMembershipRow(dir, "b"), null);
});

test("母集合を実機の一覧へ揃える: 登録簿に無い動いているスレも未割当の数と中身に入る", () => {
  const unassigned = { id: "unassigned", name: "未割当", note: "", thread: null };
  const mem = { keywords: [], threads: ["g1", "g2", "g3", "g4", "gone"] };
  // 登録簿には g1 だけ。g2〜g4 は孫スレ/人が建てたスレで登録簿に無い
  const registry = [
    th("g1", "単発A", "実装中", "running"),
    th("gone", "消えた", "実装中", "running"),
  ];
  const agents = [
    { id: "g1", title: "単発A", status: "running" },
    { id: "g2", title: "単発B", status: "idle" },
    { id: "g3", title: "単発C", status: "running" },
    { id: "g4", title: "単発D", status: "closed" }, // 宣言なしの closed は動いていない
    { id: "zz", title: "未割当に含めない", status: "running" },
  ];
  const threads = resolveLiveThreads(registry, agents);
  assert.equal(countRunning(unassigned, threads, mem), 3); // g1,g2,g3。gone は一覧に居ない=終わった
  const d = buildPriorityDetail(unassigned, threads, [], mem);
  assert.equal(d.relatedTotal, 5);
  assert.equal(d.relatedLive, 3);
  assert.deepEqual(
    d.related
      .map((t) => t.agentId)
      .slice(0, 3)
      .sort(),
    ["g1", "g2", "g3"], // 動いている順
  );
});

test("実機の一覧の判定規則: データ側 live_agents と同じ(完了済みidleは除く・running は待機以外)", () => {
  const registry = [
    th("a", "t", "完了", "idle"),
    th("b", "t", "待機", "running"),
    th("c", "t", "実装中", "closed"),
  ];
  const out = resolveLiveThreads(registry, [
    { id: "a", status: "idle" },
    { id: "b", status: "running" },
    { id: "c", status: "closed" },
    { id: "d", status: "error" },
    { id: "e", status: "idle", archivedAt: "2026-01-01" },
  ]);
  const live = Object.fromEntries(out.map((t) => [t.agentId, t.live]));
  assert.deepEqual(live, { a: false, b: false, c: true, d: false });
});

test("実機の一覧を引けないとき: 登録簿の自己申告だけで数える従来の動き", () => {
  const p = { id: "ep", name: "案件", note: "", thread: "a1" };
  const threads = resolveLiveThreads([th("a1", "案件"), th("c3", "案件", "完了")], null);
  assert.equal(countRunning(p, threads), 1);
});

test("中身の上限30は終わった行にだけ効き、動いているスレは全部並ぶ(全数と動の数も切られない)", () => {
  const p = { id: "u", name: "未割当", note: "", thread: null };
  const ids = Array.from({ length: 35 }, (_, i) => `x${i}`);
  const done = Array.from({ length: 33 }, (_, i) => `d${i}`);
  const threads = [
    ...ids.map((id) => th(id, `題名${id}`)),
    ...done.map((id) => th(id, `終${id}`, "完了", "idle")),
  ];
  const mem = { keywords: [], threads: [...ids, ...done] };
  const d = buildPriorityDetail(p, threads, [], mem);
  assert.equal(d.related.length, 35 + 30); // 動35は全部・終わった行は30まで
  assert.equal(d.relatedTotal, 68);
  assert.equal(d.relatedLive, 35);
  assert.equal(countRunning(p, threads, mem), 35);
});
