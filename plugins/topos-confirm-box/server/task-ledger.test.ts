/**
 * 窓口Bの右側の「タスク台帳」の出所の突き合わせ(`server/task-ledger.ts`)と、並び・完了の判定
 * (`shared/task-ledger.ts`)。どれも読み取りだけで、書かない。
 *
 * 見るのは、依頼の鍵(`MM/DD HH:MM#N`)で
 * 1. 項目の台帳(受付時に作られる正)と受信箱・子スレの一覧・優先順位台帳を突き合わせられるか
 * 2. 台帳がまだ無いときに、受信箱から「推測」の行として補えるか
 * 3. 一番上が最新か。「完了は隠す」で子スレが完了した行・処理済みの行が消えるか
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  filterLedgerRows,
  isLedgerDone,
  keySortValue,
  sortLedgerRows,
  type LedgerRow,
} from "../shared/task-ledger.js";
import {
  buildTaskLedger,
  extractRequestItems,
  matchProject,
  normalizeInboxKeys,
  parseInboxRequests,
  progressOf,
  readThreads,
} from "./task-ledger.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-ledger-"));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf-8");
}

const INBOX = `# 受信箱

[窓口B→裏方] 10/28 21:11 ユーザー原文: 「台帳を作って。あと、優先順位も見たい。」

- [司令塔向け自動] 2026-10-28 21:12 何かの完了

[窓口B→裏方] 21:13 ユーザー原文(担当:裏方1): 「まとめノートのエラーを直して
選択肢が切れているのも直して」
`;

function makeDirs() {
  const root = tmpdir();
  const itemsDir = path.join(root, "window_b_reply");
  const confirmBoxDir = path.join(root, "confirm_box");
  const inboxPath = path.join(root, "coordinator_inbox.md");
  fs.writeFileSync(inboxPath, INBOX, "utf-8");
  return { itemsDir, confirmBoxDir, inboxPath };
}

test("受信箱の依頼は次の見出しまでを本文として読み、日付なしの鍵は直前の日付を継ぐ", () => {
  const requests = parseInboxRequests(INBOX);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].key, "10/28 21:11");
  assert.match(requests[0].text, /台帳を作って/);
  // 自動の行(別の差出し)は依頼の本文に入れない。
  assert.doesNotMatch(requests[0].text, /司令塔向け自動/);
  assert.equal(requests[1].key, "10/28 21:13");
  assert.equal(requests[1].owner, "裏方1");
});

test("鍵の日付は前の依頼から補う(同じ日として扱う)", () => {
  assert.deepEqual(normalizeInboxKeys(["10/28 21:11", "21:13", "21:13#2"]), [
    "10/28 21:11",
    "10/28 21:13",
    "10/28 21:13#2",
  ]);
  // 日付がまだ出ていないときは触らない。
  assert.deepEqual(normalizeInboxKeys(["21:11"]), ["21:11"]);
});

test("依頼の本文から用件の文を抜き出す(あいさつは落とす)", () => {
  const items = extractRequestItems(
    "まとめノートのエラーを直して。選択肢が切れているのも直して。ご確認ください。",
  );
  assert.deepEqual(items, ["まとめノートのエラーを直して", "選択肢が切れているのも直して"]);
  // 用件らしい文が無ければ、文全体を1項目にする(空にはしない)。
  assert.deepEqual(extractRequestItems("それでいいよ"), ["それでいいよ"]);
});

test("子スレの進捗は自己申告を先に見て、無ければ Paseo の稼働状態で決める", () => {
  const base = { id: "a", title: "t", status: "", machineState: "", archived: false, updatedAt: 0 };
  assert.equal(progressOf({ ...base, status: "完了" }), "done");
  assert.equal(progressOf({ ...base, status: "ユーザー判断待ち" }), "waiting");
  // 中に「完了」を含むだけの語は完了にしない(「未完了」「完了待ち」など)。
  assert.equal(progressOf({ ...base, status: "未完了" }), "working");
  assert.equal(progressOf({ ...base, status: "完了待ち" }), "waiting");
  assert.equal(progressOf({ ...base, status: "完了(ユーザーの判断待ち)" }), "waiting");
  assert.equal(progressOf({ ...base, status: "完了(2026-10-28)" }), "done");
  assert.equal(progressOf({ ...base, machineState: "running" }), "working");
  assert.equal(progressOf({ ...base, machineState: "idle" }), "stopped");
  assert.equal(progressOf({ ...base, machineState: "closed" }), "stopped");
  assert.equal(progressOf(base), "unknown");
});

test("台帳の項目が無いときは受信箱から推測の行を作る(振り先は本文の『→ 子スレ <id>』)", async () => {
  const dirs = makeDirs();
  fs.writeFileSync(
    dirs.inboxPath,
    "[窓口B→裏方] 10/28 22:00 ユーザー原文: 「台帳を作って。子スレに振って。→ 子スレ 4c50fdd9-1111-2222-3333-444455556666」\n",
    "utf-8",
  );
  writeJson(path.join(dirs.confirmBoxDir, "child_threads.json"), {
    threads: [
      {
        agent_id: "4c50fdd9-1111-2222-3333-444455556666",
        title: "台帳の子スレ",
        declared_status: "実装中",
        machine_state: "running",
      },
    ],
  });
  const out = await buildTaskLedger(dirs);
  assert.equal(out.sources.items, false);
  assert.equal(out.sources.itemsArchive, false);
  assert.equal(out.sources.inbox, true);
  assert.equal(out.sources.childThreads, true);
  assert.ok(out.notes.some((n) => n.includes("window_b_items.json")));
  const row = out.rows[0];
  assert.equal(row.inferred, true);
  assert.equal(row.kind, "子スレ");
  assert.equal(row.children.length, 1);
  assert.equal(row.children[0].title, "台帳の子スレ");
  assert.equal(row.children[0].progress, "working");
  assert.equal(isLedgerDone(row), false);
});

test("項目の台帳があれば、それを正として受信箱の全文・子スレの進捗・プロジェクトを付ける", async () => {
  const dirs = makeDirs();
  writeJson(path.join(dirs.itemsDir, "window_b_items.json"), {
    updated_at: 0,
    items: [
      {
        key: "10/28 21:11",
        item_no: 1,
        summary: "台帳を作る",
        source: "台帳を作って",
        target: "4c50fdd9",
        kind: "子スレ",
        agent_id: "4c50fdd9-1111-2222-3333-444455556666",
        owner: "裏方1",
        received_at: 1793_000_000,
        status: "作業中",
      },
      {
        key: "10/28 21:13",
        item_no: 1,
        summary: "まとめノートのエラーを直す",
        source: "まとめノートのエラーを直して",
        target: "",
        kind: "",
        owner: "裏方1",
        received_at: 1793_000_100,
        status: "",
      },
    ],
  });
  writeJson(path.join(dirs.confirmBoxDir, "child_threads.json"), {
    threads: [
      {
        agent_id: "4c50fdd9-1111-2222-3333-444455556666",
        title: "台帳の子スレ",
        declared_status: "完了",
        machine_state: "idle",
      },
    ],
  });
  writeJson(path.join(dirs.confirmBoxDir, "priority_ledger.json"), {
    projects: [{ id: "p1", name: "窓口Bのタスク台帳", note: "台帳を作る", thread: null }],
  });

  const out = await buildTaskLedger(dirs);
  assert.equal(out.sources.items, true);
  assert.equal(out.rows.length, 2);
  const first = out.rows.find((r) => r.key === "10/28 21:11")!;
  assert.equal(first.inferred, false);
  assert.equal(first.receivedAt, 1793_000_000);
  assert.match(first.fullText, /台帳を作って/);
  assert.equal(first.children[0].progress, "done");
  assert.equal(isLedgerDone(first), true);
  // プロジェクト名が要約か依頼文に出てくるので付く。
  assert.equal(first.project?.name, "窓口Bのタスク台帳");
  // 台帳の項目がある鍵は、受信箱からの推測の行を作らない(二重に並べない)。
  assert.equal(out.rows.filter((r) => r.key === "10/28 21:11").length, 1);
});

test("優先順位台帳の説明とたまたま2文字止まりで似ているだけなら、プロジェクトは付けない", () => {
  const projects = [proj({ id: "p1", name: "別の開発", note: "台帳の作り直し" })];
  assert.equal(matchProject({ texts: ["台帳を作る"], childIds: [] }, projects), null);
  // 短い文どうしで共通の語が大半を占めるときは付ける。
  const close = [proj({ id: "p2", name: "別の名前", note: "台帳を作り直す" })];
  assert.deepEqual(matchProject({ texts: ["台帳を作り直す話"], childIds: [] }, close), {
    id: "p2",
    name: "別の名前",
  });
  // 説明の前置き(日付・ユーザー・裏方・スレ…)だけでは、無関係の依頼に付かない。
  const noisy = [
    proj({
      id: "p3",
      name: "ノイズ",
      note: "2026-10-27 14:11 ユーザー『確認箱のまとめノートのエラーを直して』 最優先。",
    }),
  ];
  assert.equal(
    matchProject({ texts: ["子スレの切替を機械化してほしい"], childIds: [] }, noisy),
    null,
  );
  // 中身が同じ依頼なら付く(前置きを落としても、要る語は残る)。
  assert.deepEqual(matchProject({ texts: ["まとめノートのエラーを直して"], childIds: [] }, noisy), {
    id: "p3",
    name: "ノイズ",
  });
});

test("「常時の方針」と片付けた開発プロジェクトは照合に使わない(優先順位画面の一覧に出ない行)", async () => {
  const projects = [
    proj({ id: "s", name: "常時の方針の名前", standing: true }),
    proj({ id: "a", name: "片付けた開発", archived: true }),
    proj({ id: "live", name: "いまの開発", thread: "4c50fdd9-1111-2222-3333-444455556666" }),
  ];
  // 組み立てを通すと、常時・片付けた行は候補から外れ、生きている行の子スレだけが付く。
  const dirs = makeDirs();
  writeJson(path.join(dirs.itemsDir, "window_b_items.json"), {
    items: [
      {
        key: "10/28 21:11",
        item_no: 1,
        summary: "常時の方針の名前の話",
        target: "4c50fdd9",
        kind: "子スレ",
        agent_id: "4c50fdd9-1111-2222-3333-444455556666",
      },
      { key: "10/28 21:13", item_no: 1, summary: "片付けた開発の話" },
    ],
  });
  writeJson(path.join(dirs.confirmBoxDir, "priority_ledger.json"), { projects });
  const out = await buildTaskLedger(dirs);
  assert.equal(out.rows.find((r) => r.key === "10/28 21:11")?.project?.id, "live");
  assert.equal(out.rows.find((r) => r.key === "10/28 21:13")?.project, null);
});

function proj(over: {
  id: string;
  name: string;
  note?: string;
  thread?: string | null;
  standing?: boolean;
  archived?: boolean;
}) {
  return {
    note: over.note ?? "",
    thread: over.thread ?? null,
    standing: over.standing ?? false,
    archived: over.archived ?? false,
    ...over,
  };
}

test("子スレ一覧が読めないときは進捗「不明」で続け、notes に出す(画面は消さない)", async () => {
  const dirs = makeDirs();
  const out = await buildTaskLedger(dirs);
  assert.equal(out.sources.childThreads, false);
  assert.ok(out.notes.some((n) => n.includes("child_threads.json")));
  assert.ok(out.rows.length > 0);
});

test("一番上が最新。同じ鍵は項目番号の順で、完了は隠せる", () => {
  const rows: LedgerRow[] = [
    makeRow({ id: "a", key: "10/28 21:11", itemNo: 1, done: true }),
    makeRow({ id: "b", key: "10/28 22:00", itemNo: 1 }),
    makeRow({ id: "c", key: "10/28 21:30#2", itemNo: 2 }),
  ];
  assert.deepEqual(
    sortLedgerRows(rows).map((r) => r.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    filterLedgerRows(rows, "hide-done").map((r) => r.id),
    ["b", "c"],
  );
  assert.equal(filterLedgerRows(rows, "show-done").length, 3);
  assert.equal(keySortValue("10/28 21:11#2"), "10282111.0002");
  // 連番は数値で比べる(#10 が #2 より後ろ=新しい)。
  const many: LedgerRow[] = [
    makeRow({ id: "two", key: "10/28 21:11#2" }),
    makeRow({ id: "ten", key: "10/28 21:11#10" }),
  ];
  assert.deepEqual(
    sortLedgerRows(many).map((r) => r.id),
    ["ten", "two"],
  );
});

test("子スレを振らない項目(代理決定・投函・説明のみ)は、振り先を書いた時点で片付いた扱い", () => {
  const r = (over: Partial<LedgerRow>) =>
    isLedgerDone(makeRow({ id: "x", key: "10/28 21:00", ...over }));
  assert.equal(r({ kind: "代理決定", settledWithoutChild: true }), true);
  assert.equal(r({ kind: "説明のみ", settledWithoutChild: true }), true);
  assert.equal(r({ kind: "子スレ", children: [child("done")] }), true);
  assert.equal(r({ kind: "子スレ", children: [child("working")] }), false);
  assert.equal(r({ kind: "", settledWithoutChild: false }), false);
  // 推測の行は、振り先が書かれていないことだけでは片付いた扱いにしない(完了を隠すと黙って消えるため)。
  assert.equal(r({ kind: "", inferred: true }), false);
  // 子スレが全部終わっていれば、推測の行でも完了として扱う(2026-10-28 出口レビュー1巡目)。
  assert.equal(r({ kind: "子スレ", children: [child("done")], inferred: true }), true);
});

test("子スレの一覧は短縮ID(8桁)でも引ける", () => {
  const dir = tmpdir();
  writeJson(path.join(dir, "child_threads.json"), {
    threads: [{ agent_id: "abcd1234-0000-0000-0000-000000000000", title: "t", status: "実装中" }],
  });
  const threads = readThreads(dir);
  assert.ok(threads);
  assert.equal(threads.get("abcd1234")?.title, "t");
  assert.equal(threads.get("abcd1234-0000-0000-0000-000000000000")?.title, "t");
});

function child(progress: "working" | "done") {
  return { id: "abcd1234", title: "t", progress, status: "", missing: false };
}

function makeRow(over: Partial<LedgerRow> & Pick<LedgerRow, "id" | "key">): LedgerRow {
  return {
    itemNo: 1,
    itemCount: 1,
    summary: over.id,
    source: "",
    fullText: "",
    receivedAt: null,
    kind: "",
    target: "",
    children: [],
    settledWithoutChild: false,
    inferred: false,
    done: false,
    targetSetAt: null,
    repliedAt: null,
    owner: "",
    project: null,
    ...over,
  };
}
