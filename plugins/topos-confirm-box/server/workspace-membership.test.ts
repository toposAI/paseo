import assert from "node:assert/strict";
import { test } from "node:test";

import { decideWorkspaceArchive } from "./workspace-membership.js";

const self = "a_self";

test("自分だけのワークスペースは閉じてよい", () => {
  const d = decideWorkspaceArchive(self, [{ id: self, status: "idle" }], false);
  assert.equal(d.safe, true);
});

test("他のスレが idle/running/error で残っていれば閉じない(司令塔ワークスペースの巻き込み防止)", () => {
  for (const status of ["idle", "running", "error", "initializing"]) {
    const d = decideWorkspaceArchive(
      self,
      [
        { id: self, status: "idle" },
        { id: "a_other", status },
      ],
      false,
    );
    assert.equal(d.safe, false, status);
  }
});

test("他のスレが closed だけなら閉じてよい(閉じても失うものが無い)", () => {
  const d = decideWorkspaceArchive(
    self,
    [
      { id: self, status: "closed" },
      { id: "a_old", status: "closed" },
    ],
    false,
  );
  assert.equal(d.safe, true);
});

test("アーカイブ済みの他のスレは数えない", () => {
  const d = decideWorkspaceArchive(
    self,
    [
      { id: self, status: "idle" },
      { id: "a_arch", status: "idle", archived: true },
    ],
    false,
  );
  assert.equal(d.safe, true);
});

test("ページに続きがあれば共有の可能性として閉じない(安全側)", () => {
  const d = decideWorkspaceArchive(self, [{ id: self, status: "idle" }], true);
  assert.equal(d.safe, false);
});

test("閉じないときのメッセージは「スレは閉じた」ことと理由を含む", () => {
  const d = decideWorkspaceArchive(self, [{ id: "a_other", status: "idle" }], false);
  assert.equal(d.safe, false);
  if (!d.safe) {
    assert.match(d.message, /スレをアーカイブしました/);
    assert.match(d.message, /共有/);
  }
});
