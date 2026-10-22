/**
 * 承認待ちが質問(AskUserQuestion / opencode の question)の時の読み替えと、
 * 回答を `updatedInput.answers` に載せる組み立てのテスト。2026-10-22。
 *
 * ここで固定したいのは3つ:
 * - 生JSONを画面に出さない(質問文・選択肢・背景が読める形になる)
 * - 選んだ選択肢が `answers`(キー=header)になる
 * - サーバーは**実物の質問に一致する回答だけ**を受け付ける(欠けたまま許可しない)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allAnswered,
  answerKeys,
  buildAnswers,
  parseQuestions,
  questionsToText,
  sanitizeAnswers,
} from "../shared/questions.ts";
import { permitQuestions, permitsToItems, questionResponse } from "./permits.ts";

const claudeInput = {
  questions: [
    {
      question: "どの方式で進めますか?",
      header: "方式",
      multiSelect: false,
      allowOther: true,
      options: [
        { label: "A案", description: "小さく試す" },
        { label: "B案", description: "一気に置き換える" },
      ],
    },
  ],
};

describe("parseQuestions", () => {
  it("Claude の AskUserQuestion 入力を読む", () => {
    const questions = parseQuestions(claudeInput);
    assert.ok(questions);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].header, "方式");
    assert.equal(questions[0].multiSelect, false);
    assert.equal(questions[0].allowOther, true);
    assert.deepEqual(questions[0].options[1], { label: "B案", description: "一気に置き換える" });
  });

  it("opencode の形(multiple)と文字列の選択肢も読む", () => {
    const questions = parseQuestions({
      questions: [{ question: "どれ?", header: "選択", multiple: true, options: ["x", "y"] }],
    });
    assert.ok(questions);
    assert.equal(questions[0].multiSelect, true);
    assert.equal(questions[0].allowOther, false);
    assert.deepEqual(
      questions[0].options.map((o) => o.label),
      ["x", "y"],
    );
  });

  it("選択肢が無ければ自由記述可にする", () => {
    const questions = parseQuestions({
      questions: [{ question: "自由に書いて", header: "メモ", options: [] }],
    });
    assert.ok(questions);
    assert.equal(questions[0].allowOther, true);
  });

  it("questions が無ければ null", () => {
    assert.equal(parseQuestions({ command: "ls" }), null);
    assert.equal(parseQuestions(null), null);
    assert.equal(parseQuestions({ questions: [] }), null);
  });
});

describe("answerKeys", () => {
  it("header を使い、空/重複は質問文で代用する", () => {
    const questions = parseQuestions({
      questions: [
        { question: "Q1?", header: "同じ", options: [{ label: "a" }] },
        { question: "Q2?", header: "同じ", options: [{ label: "b" }] },
        { question: "Q3?", header: "", options: [{ label: "c" }] },
      ],
    });
    assert.ok(questions);
    assert.deepEqual(answerKeys(questions), ["同じ", "Q2?", "Q3?"]);
  });
});

describe("buildAnswers", () => {
  const questions = parseQuestions(claudeInput);
  if (!questions) throw new Error("fixture");

  it("単一選択はラベル、その他を書いたらその他が優先", () => {
    assert.deepEqual(buildAnswers(questions, { 0: [1] }, {}), { 方式: "B案" });
    assert.deepEqual(buildAnswers(questions, { 0: [1] }, { 0: "C案で" }), { 方式: "C案で" });
  });

  it("複数選択はカンマ区切り、自由記述は後ろに足す", () => {
    const multi = parseQuestions({
      questions: [
        {
          question: "複数?",
          header: "複数",
          multiSelect: true,
          allowOther: true,
          options: [{ label: "a" }, { label: "b" }],
        },
      ],
    });
    assert.ok(multi);
    assert.deepEqual(buildAnswers(multi, { 0: [0, 1] }, { 0: "c" }), { 複数: "a, b, c" });
  });

  it("選択肢が無い質問は自由記述そのもの", () => {
    const free = parseQuestions({
      questions: [{ question: "自由?", header: "自由", options: [] }],
    });
    assert.ok(free);
    assert.deepEqual(buildAnswers(free, {}, { 0: " 42 " }), { 自由: "42" });
  });
});

describe("allAnswered", () => {
  const questions = parseQuestions(claudeInput);
  if (!questions) throw new Error("fixture");

  it("未選択だと送れない", () => {
    assert.equal(allAnswered(questions, {}, {}), false);
    assert.equal(allAnswered(questions, { 0: [0] }, {}), true);
  });
});

describe("sanitizeAnswers", () => {
  const questions = parseQuestions(claudeInput);
  if (!questions) throw new Error("fixture");

  it("実物の質問に一致する回答だけ通す", () => {
    const ok = sanitizeAnswers(questions, { 方式: "A案" });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.answers, { 方式: "A案" });
  });

  it("質問文をキーにしても通す(プロバイダ差の吸収)", () => {
    const ok = sanitizeAnswers(questions, { "どの方式で進めますか?": "A案" });
    assert.equal(ok.ok, true);
  });

  it("知らないキー・未回答・文字列以外は拒否する", () => {
    assert.equal(sanitizeAnswers(questions, { なにこれ: "x" }).ok, false);
    assert.equal(sanitizeAnswers(questions, {}).ok, false);
    // @ts-expect-error 実行時の防御(クライアントは何でも送れる)
    assert.equal(sanitizeAnswers(questions, { 方式: 1 }).ok, false);
  });
});

describe("questionsToText", () => {
  it("生JSONではなく質問文と選択肢を並べる", () => {
    const questions = parseQuestions(claudeInput);
    assert.ok(questions);
    const text = questionsToText(questions);
    assert.match(text, /\[方式\] どの方式で進めますか\?/);
    assert.match(text, /・A案 — 小さく試す/);
    assert.doesNotMatch(text, /"questions"/);
  });
});

describe("permitsToItems(質問)", () => {
  it("題名が 'Question' でも質問文を subject にし、背景を読める形にする", () => {
    const items = permitsToItems([
      {
        id: "agent-1",
        title: "担当",
        pendingPermissions: [
          {
            id: "perm-1",
            kind: "question",
            name: "question",
            title: "Question",
            input: claudeInput,
          },
        ],
      },
    ]);
    const item = items[0];
    assert.equal(item.subject, "どの方式で進めますか?");
    assert.equal(item.summary, "A案 / B案");
    assert.match(item.background, /・B案/);
    assert.doesNotMatch(item.background, /"questions"/);
    assert.equal(item.questions?.[0].header, "方式");
  });

  it("質問でない承認待ちは従来どおり(生JSONの背景・選択肢ボタン)", () => {
    const items = permitsToItems([
      {
        id: "agent-2",
        pendingPermissions: [
          { id: "perm-2", kind: "tool", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    ]);
    const item = items[0];
    assert.equal(item.questions, undefined);
    assert.match(item.background, /"command": "ls -la"/);
    assert.equal(item.subject, "Bash");
  });
});

describe("questionResponse", () => {
  const perm = { id: "perm-1", kind: "question", name: "question", input: claudeInput };

  it("updatedInput.answers を組み立てる(入力の他のキーは保つ)", () => {
    const built = questionResponse(perm, { 方式: "A案" });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.response.behavior, "allow");
    assert.deepEqual(built.response.updatedInput.answers, { 方式: "A案" });
    assert.ok(Array.isArray(built.response.updatedInput.questions));
  });

  it("質問でない承認待ちには回答を載せない", () => {
    assert.equal(questionResponse({ kind: "tool", input: {} }, { 方式: "A案" }).ok, false);
  });

  it("permitQuestions は kind が question の時だけ拾う", () => {
    assert.equal(permitQuestions({ kind: "tool", input: claudeInput }), null);
    assert.ok(permitQuestions({ kind: "question", input: claudeInput }));
  });
});
