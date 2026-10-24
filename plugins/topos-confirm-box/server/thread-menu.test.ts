import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOSED_MENU,
  OPEN_MENU,
  archiveMenuLabel,
  menuCanArchive,
  nextMenu,
  pinMenuLabel,
} from "../shared/thread-menu.js";

test("司令塔(子を持つ行)はアーカイブ項目を出さない(ピンは残す)", () => {
  // 司令塔の印が付いた行
  assert.equal(menuCanArchive({ agentId: "c", coordinator: true }, new Set()), false);
  // 印は無いが他の行の親になっている行(親を畳むと子の見出しが行き場を失う)
  assert.equal(menuCanArchive({ agentId: "p" }, new Set(["p"])), false);
  // 普通の行
  assert.equal(menuCanArchive({ agentId: "x" }, new Set(["p"])), true);
});

test("openで開き、確認はリセットされる", () => {
  const step = nextMenu(CLOSED_MENU, "open");
  assert.deepEqual(step.state, { open: true, confirmingArchive: false });
  assert.equal(step.intent, null);
  // 確認待ちから開き直しても確認は持ち越さない(閉じたあとの1回押しで実行させない)
  const again = nextMenu({ open: false, confirmingArchive: true }, "open");
  assert.deepEqual(again.state, { open: true, confirmingArchive: false });
});

test("アーカイブは1回目で確認待ちになり、2回目で実行される", () => {
  const first = nextMenu(OPEN_MENU, "archive");
  assert.deepEqual(first.state, { open: true, confirmingArchive: true });
  assert.equal(first.intent, null, "1回目では実行しない");

  const second = nextMenu(first.state, "archive");
  assert.deepEqual(second.state, CLOSED_MENU);
  assert.equal(second.intent, "archive", "2回目で初めて実行する");
});

test("closeは確認を捨てる(開き直しは1回目から)", () => {
  const armed = nextMenu(OPEN_MENU, "archive").state;
  const closed = nextMenu(armed, "close");
  assert.deepEqual(closed.state, CLOSED_MENU);
  assert.equal(closed.intent, null);

  const reopened = nextMenu(closed.state, "open").state;
  assert.equal(nextMenu(reopened, "archive").intent, null);
});

test("閉じている間の操作は無視する", () => {
  for (const action of ["close", "archive", "toggle-pin", "open-thread"] as const) {
    const step = nextMenu(CLOSED_MENU, action);
    assert.equal(step.intent, null, `${action} は実行しない`);
    assert.deepEqual(step.state, CLOSED_MENU);
  }
});

test("ピン止めとスレを開くは押した時点で実行して閉じる", () => {
  assert.deepEqual(nextMenu(OPEN_MENU, "toggle-pin"), {
    state: CLOSED_MENU,
    intent: "toggle-pin",
  });
  assert.deepEqual(nextMenu(OPEN_MENU, "open-thread"), {
    state: CLOSED_MENU,
    intent: "open-thread",
  });
  // 2回目のアーカイブ押下のつもりでピンを押しても、アーカイブは走らない
  const armed = nextMenu(OPEN_MENU, "archive").state;
  assert.equal(nextMenu(armed, "toggle-pin").intent, "toggle-pin");
});

test("ピン/アーカイブの文言は現在の状態で切り替わる", () => {
  assert.equal(pinMenuLabel(true), "ピン止めを外す");
  assert.equal(pinMenuLabel(false), "ピン止めする");
  assert.equal(archiveMenuLabel(false), "アーカイブする");
  assert.equal(archiveMenuLabel(true), "もう一度押すとアーカイブ");
});
