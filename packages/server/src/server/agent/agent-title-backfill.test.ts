import { describe, expect, test } from "vitest";
import {
  AGENT_TITLE_SOURCE_LABEL,
  AGENT_TITLE_SOURCE_USER,
} from "@getpaseo/protocol/agent-title-limits";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  TITLE_RETITLE_DONE,
  TITLE_RETITLE_LABEL,
  runTitleBackfill,
  type TitleBackfillDeps,
} from "./agent-title-backfill.js";

function record(id: string, labels: Record<string, string>, extra?: { archivedAt?: string }) {
  return {
    id,
    title: "coordinator_old",
    labels,
    archivedAt: extra?.archivedAt ?? null,
  } as unknown as StoredAgentRecord;
}

function setup(input: {
  records: StoredAgentRecord[];
  loaded?: string[];
  busy?: string[];
  /** retitle の途中で呼ばれる(呼び出し中の状態変化を再現する)。 */
  onRetitle?: (agentId: string) => void;
  retitleResult?: (agentId: string) => boolean | Error;
}) {
  const loaded = new Set(input.loaded ?? []);
  const busy = new Set(input.busy ?? []);
  const calls = {
    ensureLoaded: [] as string[],
    close: [] as string[],
    retitle: [] as string[],
    markDone: [] as string[],
  };
  const deps: TitleBackfillDeps = {
    listStored: async () => input.records,
    isLoaded: (agentId) => loaded.has(agentId),
    isBusy: (agentId) => busy.has(agentId),
    ensureLoaded: async (agentId) => {
      calls.ensureLoaded.push(agentId);
    },
    close: async (agentId) => {
      calls.close.push(agentId);
    },
    retitle: async (agentId) => {
      calls.retitle.push(agentId);
      input.onRetitle?.(agentId);
      const outcome = input.retitleResult?.(agentId) ?? true;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    markDone: async (agentId) => {
      calls.markDone.push(agentId);
    },
    logger: createTestLogger(),
  };
  return { deps, calls, busy };
}

describe("runTitleBackfill", () => {
  test("only touches marked, unarchived, non-internal agents", async () => {
    const { deps, calls } = setup({
      records: [
        record("a", { [TITLE_RETITLE_LABEL]: "1" }),
        record("b", { [TITLE_RETITLE_LABEL]: "done" }),
        record("c", {}),
        record("d", { [TITLE_RETITLE_LABEL]: "1" }, { archivedAt: "2026-10-01T00:00:00.000Z" }),
        { ...record("e", { [TITLE_RETITLE_LABEL]: "1" }), internal: true } as StoredAgentRecord,
        // 常駐の役スレ(窓口B など)。名前を識別子にしているので、印があっても題名は変えない。
        record("f", {
          [TITLE_RETITLE_LABEL]: "1",
          [AGENT_TITLE_SOURCE_LABEL]: AGENT_TITLE_SOURCE_USER,
        }),
      ],
    });
    const result = await runTitleBackfill(deps);
    // アーカイブ済み・内部用・人が固定した題名の3本は対象から外れる(合図は残す)。
    expect(result).toEqual({ marked: 1, retitled: 1, failed: 0, skipped: 0, busy: 0, excluded: 3 });
    expect(calls.retitle).toEqual(["a"]);
    expect(calls.markDone).toEqual(["a"]);
  });

  test("loads and closes a closed agent, leaves an already-open one open", async () => {
    const { deps, calls } = setup({
      records: [
        record("closed", { [TITLE_RETITLE_LABEL]: "1" }),
        record("open", { [TITLE_RETITLE_LABEL]: "1" }),
      ],
      loaded: ["open"],
    });
    await runTitleBackfill(deps);
    expect(calls.ensureLoaded).toEqual(["closed"]);
    expect(calls.close).toEqual(["closed"]);
  });

  test("a failure still clears the mark so the one-shot does not loop", async () => {
    const { deps, calls } = setup({
      records: [
        record("boom", { [TITLE_RETITLE_LABEL]: "1" }),
        record("nogen", { [TITLE_RETITLE_LABEL]: "1" }),
      ],
      retitleResult: (agentId) => (agentId === "boom" ? new Error("boom") : false),
    });
    const result = await runTitleBackfill(deps);
    expect(result).toEqual({ marked: 2, retitled: 0, failed: 1, skipped: 1, busy: 0, excluded: 0 });
    expect(calls.markDone).toEqual(["boom", "nogen"]);
    expect(calls.close).toEqual(["boom", "nogen"]);
  });

  test("does nothing (and logs nothing) when no agent is marked", async () => {
    const { deps, calls } = setup({ records: [record("a", {})] });
    const result = await runTitleBackfill(deps);
    expect(result).toEqual({ marked: 0, retitled: 0, failed: 0, skipped: 0, busy: 0, excluded: 0 });
    expect(calls.retitle).toEqual([]);
  });

  test("the done mark is not `1`, so a second run does not repeat", async () => {
    expect(TITLE_RETITLE_DONE).not.toBe("1");
  });

  // 回帰: 実行中のスレを閉じるとターンごと中断してしまう(2026-10-27 出口レビュー指摘1)。
  test("never touches an agent that is running when the pass reaches it", async () => {
    const { deps, calls } = setup({
      records: [record("running", { [TITLE_RETITLE_LABEL]: "1" })],
      busy: ["running"],
    });
    const result = await runTitleBackfill(deps);
    expect(result).toEqual({ marked: 1, retitled: 0, failed: 0, skipped: 0, busy: 1, excluded: 0 });
    expect(calls.retitle).toEqual([]);
    expect(calls.close).toEqual([]);
    // 印は残す: 触っていないのだから「済み」にしてはいけない。
    expect(calls.markDone).toEqual([]);
  });

  // 回帰: 読み込んだ後に誰かが送り始めた場合も、閉じる直前に見直す(同 指摘1)。
  test("leaves the agent open when it became busy while the title was being generated", async () => {
    const { deps, calls, busy } = setup({
      records: [record("late", { [TITLE_RETITLE_LABEL]: "1" })],
      onRetitle: (agentId) => busy.add(agentId),
    });
    await runTitleBackfill(deps);
    expect(calls.ensureLoaded).toEqual(["late"]);
    expect(calls.close).toEqual([]);
    expect(calls.markDone).toEqual(["late"]);
  });

  // 回帰: 最近動いたスレを先に処理すると、その復元で始まるターンを待つ間に列の後ろが
  // 止まった(2026-10-27 本番: 20分近く1本も終わらなかった)。古い順に処理する。
  test("processes the least recently updated agent first", async () => {
    const withUpdatedAt = (id: string, updatedAt: string) =>
      ({ ...record(id, { [TITLE_RETITLE_LABEL]: "1" }), updatedAt }) as StoredAgentRecord;
    const { deps, calls } = setup({
      records: [
        withUpdatedAt("recent", new Date().toISOString()),
        withUpdatedAt("old", "2026-10-26T00:00:00.000Z"),
        withUpdatedAt("mid", "2026-10-27T00:00:00.000Z"),
      ],
    });
    await runTitleBackfill(deps);
    expect(calls.retitle).toEqual(["old", "mid", "recent"]);
  });
});
