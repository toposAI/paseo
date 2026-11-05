import assert from "node:assert/strict";
import { test } from "node:test";
import { splitReportBody } from "../shared/report-body.js";

test("![]() の行と、パスだけの行を画像にし、文中のパスは文字のまま", () => {
  const segs = splitReportBody(
    [
      "# 題",
      "本文 /Users/u/final/a.png を見る",
      "![pc](/Users/u/.paseo/worktrees/x/final/pc_home.png)",
      "- `/Users/u/final/iphone_home.png` (https://e/m.html#v=1)",
      "```",
      "/Users/u/final/in_code.png",
      "```",
      "おわり",
    ].join("\n"),
  );
  assert.deepEqual(
    segs.map((s) => (s.t === "img" ? `img:${s.path}` : "md")),
    [
      "md",
      "img:/Users/u/.paseo/worktrees/x/final/pc_home.png",
      "img:/Users/u/final/iphone_home.png",
      "md",
    ],
  );
  const last = segs[segs.length - 1];
  assert.ok(last.t === "md" && last.text.includes("in_code.png") && last.text.includes("おわり"));
  const first = segs[0];
  assert.ok(
    first.t === "md" && first.text.includes("文中") === false && first.text.includes("a.png"),
  );
});

test("画像でない拡張子・相対パスは画像にしない", () => {
  const segs = splitReportBody("![x](rel/a.png)\n/Users/u/a.txt");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].t, "md");
});
