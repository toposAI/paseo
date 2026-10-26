#!/usr/bin/env node
// 既存スレの題名を一度だけ LLM に付け直させるための印を、生きているスレ全部にまとめて付ける。
//
// 背景: 2026-10-26 以前に作られたスレは題名ラベル(`paseo.title-source`)を持たないため、
// 一括付け直しの印(`paseo.title-retitle=1`)を立てたものだけを新しいデーモンが拾って付け直す。
// 1本ずつ確認しながらの運用を避けるため、ここでまとめて印を付ける。
//
// ラベルだけを変えるので題名は動かない(`paseo agent update` はラベルだけの更新では
// 題名を触らない)。デーモンの状態ファイルを直接書き換えると、デーモンが後で上書きする
// ことがあるため、必ず CLI 経由で書く。
//
// 用法:
//   node scripts/mark-title-retitle.mjs            # 対象を一覧するだけ(何も書かない)
//   node scripts/mark-title-retitle.mjs --execute  # 印を付ける
//
// 対象 = アーカイブ済み・内部用(internal)を除いた全スレ。
// `paseo.title-source=user`(人が固定した題名)のスレは対象外にする(役スレの名前を守る)。

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RETITLE_LABEL = "paseo.title-retitle";
const SOURCE_LABEL = "paseo.title-source";
const RETITLE_DONE = "done";

const execute = process.argv.slice(2).includes("--execute");
const paseo = process.env.PASEO_BIN || "paseo";
const agentsRoot = join(homedir(), ".paseo", "agents");

const records = [];
for (const dir of readdirSync(agentsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const sub = join(agentsRoot, dir.name);
  for (const file of readdirSync(sub)) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(sub, file), "utf8"));
      if (record?.id && !record.archivedAt && !record.internal) records.push(record);
    } catch {
      // 壊れたファイルは触らない
    }
  }
}

const targets = [];
let locked = 0;
let alreadyDone = 0;
let alreadyMarked = 0;
for (const record of records) {
  const labels = record.labels ?? {};
  if (labels[SOURCE_LABEL] === "user") {
    locked += 1;
    continue;
  }
  if (labels[RETITLE_LABEL] === RETITLE_DONE) {
    alreadyDone += 1;
    continue;
  }
  if (labels[RETITLE_LABEL] === "1") {
    alreadyMarked += 1;
    targets.push(record);
    continue;
  }
  targets.push(record);
}

for (const record of targets) {
  console.log(`${record.id.slice(0, 8)}  ${record.title ?? "(なし)"}`);
}

let failed = 0;
if (execute) {
  for (const record of targets) {
    if ((record.labels ?? {})[RETITLE_LABEL] === "1") continue;
    try {
      execFileSync(paseo, ["agent", "update", record.id, "--label", `${RETITLE_LABEL}=1`], {
        stdio: "pipe",
      });
    } catch (error) {
      failed += 1;
      console.error(`失敗 ${record.id.slice(0, 8)}: ${error.message}`);
    }
  }
}

console.log(
  [
    "",
    `生存スレ ${records.length} 本 / 対象 ${targets.length} 本`,
    `新たに印を付ける ${targets.length - alreadyMarked} 本 / 既に印あり ${alreadyMarked} 本 / 付け直し済み ${alreadyDone} 本 / 固定題名で除外 ${locked} 本`,
    execute ? `実行しました(失敗 ${failed} 本)` : "(予告。--execute で実行)",
  ].join("\n"),
);
