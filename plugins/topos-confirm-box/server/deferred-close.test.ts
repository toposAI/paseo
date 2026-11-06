import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeferredCloser } from "../shared/deferred-close.js";
import type { CloserTimers } from "../shared/deferred-close.js";

function fakeTimers() {
  let n = 0;
  const jobs = new Map<number, () => void>();
  const timers: CloserTimers = {
    set: (fn) => {
      jobs.set(++n, fn);
      return n;
    },
    clear: (h) => void jobs.delete(h as number),
  };
  return { timers, run: () => Array.from(jobs.values()).forEach((f) => f()), jobs };
}

test("猶予が切れたら commit を1回呼ぶ", () => {
  const f = fakeTimers();
  const got: string[] = [];
  const c = createDeferredCloser<string>(
    (id, p) => got.push(`${id}:${p}`),
    () => {},
    10,
    f.timers,
  );
  assert.equal(c.schedule("a", "done"), true);
  assert.equal(c.has("a"), true);
  assert.deepEqual(got, []);
  f.run();
  assert.deepEqual(got, ["a:done"]);
  assert.equal(c.has("a"), false);
});

test("猶予中に元に戻せば commit しない", () => {
  const f = fakeTimers();
  const got: string[] = [];
  const c = createDeferredCloser<string>(
    (id) => got.push(id),
    () => {},
    10,
    f.timers,
  );
  c.schedule("a", "x");
  assert.equal(c.undo("a"), true);
  f.run();
  assert.deepEqual(got, []);
  assert.equal(c.undo("a"), false);
});

test("二重に積まない・flushAll は待たずに全部書く", () => {
  const f = fakeTimers();
  const got: string[] = [];
  const c = createDeferredCloser<string>(
    (id) => got.push(id),
    () => {},
    10,
    f.timers,
  );
  assert.equal(c.schedule("a", "x"), true);
  assert.equal(c.schedule("a", "x"), false);
  c.schedule("b", "y");
  c.flushAll();
  assert.deepEqual(got.sort(), ["a", "b"]);
  assert.equal(f.jobs.size, 0);
});
