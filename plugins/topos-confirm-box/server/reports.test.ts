import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readCardChat } from "./cardchat.js";
import {
  allowedReportFile,
  commentOnReport,
  countUnreadReports,
  listReports,
  markAllReportsRead,
  markReportRead,
  readReportBody,
  readReportImage,
  readReportRows,
} from "./reports.js";

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reports-")));
}

function seed(dir: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(
    path.join(dir, "reports.jsonl"),
    rows.map((r) => JSON.stringify({ t: "report", ...r })).join("\n") + "\n",
  );
}

const base = {
  title: "題",
  path: "/x.md",
  rel: "x.md",
  url: "https://e/",
  agent_id: "agent-1",
  agent_name: "",
};

test("開いたら既読・更新(shaが変わる)されたら未読に戻る・新しい順", () => {
  const dir = tmp();
  seed(dir, [
    { ...base, id: "a", ts: 1, sha: "s1" },
    { ...base, id: "b", ts: 2, sha: "s1" },
  ]);
  assert.deepEqual(
    listReports(dir).map((r) => [r.id, r.unread]),
    [
      ["b", true],
      ["a", true],
    ],
  );
  assert.ok(markReportRead(dir, "a"));
  assert.equal(countUnreadReports(dir), 1);
  // 同じ報告書が更新された(同じ id・別の sha)
  fs.appendFileSync(
    path.join(dir, "reports.jsonl"),
    JSON.stringify({ t: "report", ...base, id: "a", ts: 3, sha: "s2" }) + "\n",
  );
  const rows = listReports(dir);
  assert.deepEqual(
    rows.map((r) => [r.id, r.unread]),
    [
      ["a", true],
      ["b", true],
    ],
  );
  assert.equal(readReportRows(dir).length, 2);
  assert.equal(markAllReportsRead(dir), 2);
  assert.equal(countUnreadReports(dir), 0);
  assert.equal(markReportRead(dir, "zzz"), false);
});

test("コメントは報告元が分かる報告にだけ送れ、返事と並んで読める", () => {
  const dir = tmp();
  seed(dir, [
    { ...base, id: "a", ts: 1, sha: "s" },
    { ...base, id: "n", ts: 2, sha: "s", agent_id: "" },
  ]);
  assert.equal(commentOnReport(dir, "n", "こんにちは").ok, false);
  assert.equal(commentOnReport(dir, "a", "  ").ok, false);
  assert.equal(commentOnReport(dir, "none", "x").ok, false);
  const text = "1行目\n2行目\n3行目";
  assert.ok(commentOnReport(dir, "a", text, 1_700_000_000_000).ok);
  const msgs = readCardChat(dir, { id: "report:a" });
  assert.deepEqual(
    msgs.map((m) => [m.role, m.by]),
    [
      ["user", "plugin"],
      ["reply", "ack"],
    ].map(([r]) => [r, msgs[r === "user" ? 0 : 1].by]),
  );
  assert.equal(msgs[0].text, text);
  const chat = fs.readFileSync(
    path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("events-"))!),
    "utf-8",
  );
  assert.ok(chat.includes('"source":"report"'));
});

test("読める範囲: reviews の .md と final の画像だけ。symlink・範囲外は不可", () => {
  const home = tmp();
  const reviews = path.join(home, ".local/state/toposai/reviews");
  const finalDir = path.join(home, ".paseo/worktrees/w1/final");
  fs.mkdirSync(reviews, { recursive: true });
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(reviews, "r.md"), "# 報告\n本文");
  fs.writeFileSync(path.join(reviews, "p.png"), "PNG");
  fs.writeFileSync(path.join(finalDir, "pc_a.png"), "PNG");
  fs.writeFileSync(path.join(finalDir, "n.md"), "x");
  fs.writeFileSync(path.join(home, "secret.md"), "x");
  fs.symlinkSync(path.join(home, "secret.md"), path.join(reviews, "link.md"));
  const env = { REPORT_FILE_URL_HOME: home } as NodeJS.ProcessEnv;
  assert.ok(allowedReportFile(path.join(reviews, "r.md"), env));
  assert.ok(allowedReportFile(path.join(finalDir, "pc_a.png"), env));
  assert.equal(allowedReportFile(path.join(finalDir, "n.md"), env), null);
  assert.equal(allowedReportFile(path.join(home, "secret.md"), env), null);
  assert.equal(allowedReportFile(path.join(reviews, "link.md"), env), null);
  assert.equal(allowedReportFile("relative.md", env), null);
  const row = { ...readReportRowsStub(path.join(reviews, "r.md")) };
  assert.equal(readReportBody(row, env).markdown, "# 報告\n本文");
  assert.ok(
    readReportImage(path.join(finalDir, "pc_a.png"), env).dataUri.startsWith(
      "data:image/png;base64,",
    ),
  );
  assert.equal(readReportImage(path.join(home, "secret.md"), env).ok, false);
});

function readReportRowsStub(p: string) {
  return {
    id: "a",
    ts: 1,
    title: "t",
    path: p,
    rel: "",
    url: "",
    sha: "s",
    agentId: "a",
    agentName: "",
  };
}
