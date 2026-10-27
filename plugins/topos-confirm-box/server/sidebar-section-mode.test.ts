import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SIDEBAR_SECTION,
  SIDEBAR_SECTION_STORAGE_KEY,
  emptySectionLabel,
  loadStoredSection,
  normalizeSidebarSection,
  parseStoredSection,
  saveStoredSection,
  sectionAfterPress,
} from "../shared/sidebar-section-mode.js";

test("初期値はスレ一覧", () => {
  assert.equal(DEFAULT_SIDEBAR_SECTION, "threads");
  assert.equal(parseStoredSection(null), "threads");
  assert.equal(parseStoredSection(""), "threads");
  assert.equal(normalizeSidebarSection(undefined), "threads");
  assert.equal(normalizeSidebarSection("bogus"), "threads");
});

test("タブを押すと切り替わる(同じタブを押しても入れ替えない)", () => {
  assert.equal(sectionAfterPress("threads", "concepts"), "concepts");
  assert.equal(sectionAfterPress("concepts", "threads"), "threads");
  assert.equal(sectionAfterPress("concepts", "concepts"), "concepts");
  assert.equal(sectionAfterPress("threads", "unknown"), "threads");
});

test("保存値を読み戻せる。読めない値・NaN 相当は既定タブ", () => {
  assert.equal(parseStoredSection("concepts"), "concepts");
  assert.equal(parseStoredSection("threads"), "threads");
  assert.equal(parseStoredSection("<>"), "threads");
});

test("localStorage が無い・読めない・書けないときは既定タブで落ちない", () => {
  assert.equal(loadStoredSection(undefined), "threads");
  assert.equal(
    loadStoredSection({
      getItem() {
        throw new Error("SecurityError");
      },
    }),
    "threads",
  );
  assert.equal(
    saveStoredSection(
      {
        setItem() {
          throw new Error("QuotaExceededError");
        },
      },
      "concepts",
    ),
    false,
  );
  assert.equal(saveStoredSection(undefined, "concepts"), false);
});

test("localStorage の読み書きは同じキーを使う", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(loadStoredSection(storage), "threads");
  assert.equal(saveStoredSection(storage, "concepts"), true);
  assert.equal(store.get(SIDEBAR_SECTION_STORAGE_KEY), "concepts");
  assert.equal(loadStoredSection(storage), "concepts");
});

test("空一覧の文言はタブごとに違う", () => {
  assert.equal(emptySectionLabel("threads"), "実装中のスレはありません");
  assert.equal(emptySectionLabel("concepts"), "進行中の構想はありません");
  assert.equal(emptySectionLabel("projects"), "参加している共有プロジェクトはありません");
});
