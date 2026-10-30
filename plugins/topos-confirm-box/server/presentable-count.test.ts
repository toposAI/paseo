/**
 * サイドバーのバッジ=窓口Aがいま出せる件数。数えるのは判断窓口の Python 1か所だけで、
 * ここは呼んで数字を読むだけ(条件を書き写さない)。2026-10-28 ユーザー「そしたらバッジださないでよ」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedPresentableCounter,
  computeBadge,
  computePresentable,
  resolveBadgeCounter,
  resolvePresentableCounter,
} from "./presentable-count.js";

/** 偽の python: 標準出力に固定の文字列を出し、渡された引数を argv.log へ書き出す。 */
function fakePython(body: string): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
  const script = path.join(dir, "python3");
  const log = path.join(dir, "argv.log");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${JSON.stringify(log)}\nprintf '%s' ${JSON.stringify(body)}\n`,
    { mode: 0o755 },
  );
  return { dir, log };
}

/** 偽のチェックアウト(中に antigravity/utils/judgment_window.py がある形)。 */
function fakeCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-"));
  fs.mkdirSync(path.join(dir, "antigravity", "utils"), { recursive: true });
  fs.writeFileSync(path.join(dir, "antigravity", "utils", "judgment_window.py"), "");
  return dir;
}

test("設定が無い(チェックアウトが無い)ときは null=バッジに数字を出さない", () => {
  assert.equal(
    resolvePresentableCounter({ TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: "/nonexistent" }),
    null,
  );
});

test("Python の答え(1 と 0)をそのまま返す", async () => {
  const co = fakeCheckout();
  const { dir } = fakePython('{"presentable": 1}');
  const run = resolvePresentableCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: co,
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: path.join(dir, "python3"),
  });
  assert.ok(run);
  assert.equal(await run(), 1);
  const zero = fakePython('{"presentable": 0}');
  const run0 = resolvePresentableCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: co,
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: path.join(zero.dir, "python3"),
  });
  assert.equal(await (run0 as NonNullable<typeof run0>)(), 0);
});

test("null・壊れた出力・python が落ちたときは null(0件と偽らない)", async () => {
  const co = fakeCheckout();
  for (const body of ['{"presentable": null}', "not json", '{"presentable": -1}']) {
    const { dir } = fakePython(body);
    const run = resolvePresentableCounter({
      TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: co,
      TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: path.join(dir, "python3"),
    });
    assert.equal(await (run as NonNullable<typeof run>)(), null, body);
  }
  const run = resolvePresentableCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: co,
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: "/nonexistent/python3",
  });
  assert.equal(await (run as NonNullable<typeof run>)(), null);
});

test("Python には `badge-count` だけを渡す(`--commit` を戻したら落ちる。押下で件を先取りしない)", async () => {
  const co = fakeCheckout();
  const { dir, log } = fakePython('{"presentable": 1}');
  const run = resolvePresentableCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: co,
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: path.join(dir, "python3"),
  });
  assert.ok(run);
  await run();
  const args = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(args.length, 2, `引数は [script, "badge-count"] だけ: ${args.join(" ")}`);
  assert.equal(path.basename(args[0]), "judgment_window.py");
  assert.equal(args[1], "badge-count");
});

test("computePresentable: 判断ノートを読まない設定のときだけ null。数えられない・例外も null(0件と偽らない)", async () => {
  const one = async () => 1;
  const zero = async () => 0;
  assert.equal(await computePresentable(true, one), 1);
  assert.equal(await computePresentable(true, zero), 0, "0 は窓口の答えとしてそのまま出す");
  assert.equal(await computePresentable(false, one), null, "読まない設定では数字を出さない");
  assert.equal(await computePresentable(true, null), null, "Python が無いときは 0 にしない");
  assert.equal(
    await computePresentable(true, async () => {
      throw new Error("boom");
    }),
    null,
    "例外も 0 にしない",
  );
});

test("短時間はキャッシュ(3か所が30秒毎に引く)・時間が経てば取り直す", async () => {
  let calls = 0;
  let t = 1_000;
  const counter = cachedPresentableCounter(
    async () => {
      calls += 1;
      return calls;
    },
    10_000,
    () => t,
  ) as NonNullable<ReturnType<typeof cachedPresentableCounter>>;
  const [a, b] = await Promise.all([counter(), counter()]);
  assert.equal(a, 1);
  assert.equal(b, 1, "同時に引いても python は1回(飛行中を共有)");
  assert.equal(calls, 1);
  t += 5_000;
  assert.equal(await counter(), 1);
  assert.equal(calls, 1, "10秒以内はキャッシュ");
  t += 11_000;
  assert.equal(await counter(), 2);
});

function badgeRunnerFor(body: string) {
  const { dir } = fakePython(body);
  return resolveBadgeCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: fakeCheckout(),
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: path.join(dir, "python3"),
  }) as NonNullable<ReturnType<typeof resolveBadgeCounter>>;
}

test("resolveBadgeCounter: presentable と total を両方そのまま返す(1/10)", async () => {
  assert.deepEqual(await badgeRunnerFor('{"presentable": 1, "total": 10}')(), {
    presentable: 1,
    total: 10,
    consulting: null,
  });
  assert.deepEqual(await badgeRunnerFor('{"presentable": 0, "total": 0}')(), {
    presentable: 0,
    total: 0,
    consulting: null,
  });
});

test("resolveBadgeCounter: 裏方が検討中の件数 consulting もそのまま返す(壊れていれば null)", async () => {
  assert.deepEqual(await badgeRunnerFor('{"presentable": 1, "total": 11, "consulting": 2}')(), {
    presentable: 1,
    total: 11,
    consulting: 2,
  });
  assert.deepEqual(await badgeRunnerFor('{"presentable": 1, "total": 11, "consulting": -1}')(), {
    presentable: 1,
    total: 11,
    consulting: null,
  });
});

test("resolveBadgeCounter: 片方が壊れていてももう片方は生かす・総数の無い古い Python でも presentable は出す", async () => {
  assert.deepEqual(await badgeRunnerFor('{"presentable": 1}')(), {
    presentable: 1,
    total: null,
    consulting: null,
  });
  assert.deepEqual(await badgeRunnerFor('{"presentable": 1, "total": null}')(), {
    presentable: 1,
    total: null,
    consulting: null,
  });
  assert.deepEqual(await badgeRunnerFor('{"presentable": null, "total": 7}')(), {
    presentable: null,
    total: 7,
    consulting: null,
  });
  assert.deepEqual(await badgeRunnerFor('{"presentable": 1, "total": -3}')(), {
    presentable: 1,
    total: null,
    consulting: null,
  });
});

test("resolveBadgeCounter: 壊れた出力・python が落ちたときは両方 null(0件と偽らない)", async () => {
  const none = { presentable: null, total: null, consulting: null };
  assert.deepEqual(await badgeRunnerFor("not json")(), none);
  const down = resolveBadgeCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: fakeCheckout(),
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: "/nonexistent/python3",
  }) as NonNullable<ReturnType<typeof resolveBadgeCounter>>;
  assert.deepEqual(await down(), none);
  assert.equal(resolveBadgeCounter({ TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: "/nonexistent" }), null);
});

test("Python には `badge-count` だけを渡す(2数版でも引数は増やさない)", async () => {
  const co = fakeCheckout();
  const { dir, log } = fakePython('{"presentable": 1, "total": 10}');
  const run = resolveBadgeCounter({
    TOPOS_CONFIRM_BOX_JUDGMENT_CLI_DIR: co,
    TOPOS_CONFIRM_BOX_JUDGMENT_PYTHON: path.join(dir, "python3"),
  }) as NonNullable<ReturnType<typeof resolveBadgeCounter>>;
  await run();
  const args = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(args.length, 2);
  assert.equal(args[1], "badge-count");
});

test("computeBadge: 読まない設定・Python 無し・例外は両方 null。それ以外は答えをそのまま", async () => {
  const none = { presentable: null, total: null, consulting: null };
  const ok = async () => ({ presentable: 1, total: 10, consulting: 2 });
  assert.deepEqual(await computeBadge(true, ok), { presentable: 1, total: 10, consulting: 2 });
  assert.deepEqual(await computeBadge(false, ok), none);
  assert.deepEqual(await computeBadge(true, null), none);
  assert.deepEqual(
    await computeBadge(true, async () => {
      throw new Error("boom");
    }),
    none,
  );
});

test("cachedPresentableCounter は2数版でも同じ回り方(同時に引いても python は1回)", async () => {
  let calls = 0;
  const counter = cachedPresentableCounter(async () => {
    calls += 1;
    return { presentable: 1, total: 10 };
  }) as NonNullable<
    ReturnType<typeof cachedPresentableCounter<{ presentable: number; total: number }>>
  >;
  const [a, b] = await Promise.all([counter(), counter()]);
  assert.deepEqual(a, { presentable: 1, total: 10 });
  assert.deepEqual(b, a);
  assert.equal(calls, 1);
});
