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
  anyTruncated,
  buildAnswers,
  parseQuestions,
  questionsToText,
  sanitizeAnswers,
  uniqueOptionKeys,
} from "../shared/questions.ts";
import {
  answerlessAllowBlocked,
  permitQuestions,
  permitsToItems,
  questionResponse,
} from "./permits.ts";

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

describe("切り詰め(truncated)", () => {
  it("通常の質問は truncated=false", () => {
    const questions = parseQuestions(claudeInput);
    assert.ok(questions);
    assert.equal(anyTruncated(questions), false);
  });

  it("長すぎるラベルは切り詰め、回答に使えないので truncated を立てる", () => {
    const longLabel = "あ".repeat(500);
    const questions = parseQuestions({
      questions: [{ question: "Q?", header: "H", options: [{ label: longLabel }] }],
    });
    assert.ok(questions);
    // `…` は付けない(上流のラベルと一致しなくなる)。
    assert.equal(questions[0].options[0].label.length, 200);
    assert.doesNotMatch(questions[0].options[0].label, /…$/);
    assert.equal(questions[0].truncated, true);
    assert.equal(anyTruncated(questions), true);
  });

  it("選択肢の数が上限を超えたら truncated", () => {
    const questions = parseQuestions({
      questions: [
        {
          question: "Q?",
          header: "H",
          options: Array.from({ length: 20 }, (_, i) => ({ label: `o${i}` })),
        },
      ],
    });
    assert.ok(questions);
    assert.equal(questions[0].truncated, true);
  });

  it("読めない質問を1つでも落としたら、残りも truncated にして部分回答を防ぐ", () => {
    const questions = parseQuestions({
      questions: [
        { header: "H", options: [] },
        { question: "Q?", header: "H2", options: [] },
      ],
    });
    assert.ok(questions);
    assert.equal(questions.length, 1);
    assert.equal(anyTruncated(questions), true);
  });
});

describe("uniqueOptionKeys", () => {
  it("同じラベルでもキーが衝突しない", () => {
    const keys = uniqueOptionKeys([
      { label: "A", description: null },
      { label: "A", description: null },
    ]);
    assert.deepEqual(keys, ["A", "A #2"]);
  });

  it("連番の候補が既存ラベルと衝突しても一意にする", () => {
    const keys = uniqueOptionKeys([
      { label: "A", description: null },
      { label: "A", description: null },
      { label: "A #2", description: null },
    ]);
    assert.equal(new Set(keys).size, 3);
  });
});

describe("古いサーバー由来の項目(truncated が無い)", () => {
  it("undefined は「答えられない」側に倒す", () => {
    const questions = parseQuestions(claudeInput);
    assert.ok(questions);
    // 欄を知らない版が返した項目を模す。
    const stale = questions.map((question) =>
      Object.assign({}, question, { truncated: undefined as never }),
    );
    assert.equal(anyTruncated(stale), true);
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

  it("長すぎる回答は切らずに拒否する(切ると別の回答になる)", () => {
    const tooLong = sanitizeAnswers(questions, { 方式: "あ".repeat(501) });
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.match(tooLong.message, /スレで答えて/);
    // 上限ちょうどは通る。
    assert.equal(sanitizeAnswers(questions, { 方式: "あ".repeat(500) }).ok, true);
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
    // kind が無い(または空)承認待ちは質問として扱わない。input に questions が
    // あっても、別ツールの入力をフォームにしてはいけない。
    assert.equal(permitQuestions({ input: claudeInput }), null);
    assert.equal(permitQuestions({ kind: "", input: claudeInput }), null);
    assert.ok(permitQuestions({ kind: "question", input: claudeInput }));
  });

  it("切り詰めが起きた質問は回答を受け付けない(上流の実物と一致しない)", () => {
    const longPerm = {
      kind: "question",
      input: {
        questions: [
          {
            question: "Q?",
            header: "H",
            options: Array.from({ length: 20 }, (_, i) => ({ label: `o${i}` })),
          },
        ],
      },
    };
    const built = questionResponse(longPerm, { H: "o0" });
    assert.equal(built.ok, false);
    if (!built.ok) assert.match(built.message, /スレで答えて/);
  });
});

describe("answerlessAllowBlocked", () => {
  it("kind=question なら回答なしの許可を止める(質問が0件に読めても止める)", () => {
    // input.questions が読めない(配列でない)ので permitQuestions は null を返すが、
    // kind が question である以上、回答なしの許可は通してはいけない。
    const unreadable = { kind: "question", input: { questions: "壊れた" } };
    assert.equal(permitQuestions(unreadable), null);
    assert.equal(answerlessAllowBlocked(unreadable, { behavior: "allow" }), true);
    assert.equal(answerlessAllowBlocked(unreadable, { behavior: "deny" }), false);
  });

  it("質問でない承認待ちの許可は止めない", () => {
    assert.equal(
      answerlessAllowBlocked({ kind: "tool", input: claudeInput }, { behavior: "allow" }),
      false,
    );
    assert.equal(answerlessAllowBlocked({ input: claudeInput }, { behavior: "allow" }), false);
  });
});

describe("allowEmpty", () => {
  const empty = parseQuestions({
    questions: [
      { question: "メモは?", header: "メモ", allowEmpty: true, options: [{ label: "a" }] },
      { question: "必須は?", header: "必須", options: [{ label: "b" }] },
    ],
  });
  if (!empty) throw new Error("fixture");

  it("allowEmpty の質問だけ空のまま送れる", () => {
    assert.equal(allAnswered(empty, {}, { 0: "" }), false);
    assert.equal(allAnswered(empty, { 0: [] }, { 0: "" }), false);
    const onlyEmpty = parseQuestions({
      questions: [
        { question: "メモは?", header: "メモ", allowEmpty: true, options: [{ label: "a" }] },
      ],
    });
    assert.ok(onlyEmpty);
    assert.equal(allAnswered(onlyEmpty, {}, {}), true);
    assert.deepEqual(buildAnswers(onlyEmpty, {}, {}), { メモ: "" });
    // 選んだなら空ではなく選択肢が載る(allowEmpty は「空でもよい」の意味)。
    assert.deepEqual(buildAnswers(onlyEmpty, { 0: [0] }, {}), { メモ: "a" });
  });

  it("allowEmpty でない質問は空文字を受け付けない", () => {
    // メモは allowEmpty なので空で通る。必須は空だと弾く。
    assert.equal(sanitizeAnswers(empty, { メモ: "", 必須: "b" }).ok, true);
    assert.equal(sanitizeAnswers(empty, { メモ: "", 必須: "" }).ok, false);
  });
});
