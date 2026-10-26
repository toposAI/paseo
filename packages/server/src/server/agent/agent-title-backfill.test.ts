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
  retitleResult?: (agentId: string) => boolean | Error;
}) {
  const loaded = new Set(input.loaded ?? []);
  const calls = {
    ensureLoaded: [] as string[],
    close: [] as string[],
    retitle: [] as string[],
    markDone: [] as string[],
  };
  const deps: TitleBackfillDeps = {
    listStored: async () => input.records,
    isLoaded: (agentId) => loaded.has(agentId),
    ensureLoaded: async (agentId) => {
      calls.ensureLoaded.push(agentId);
    },
    close: async (agentId) => {
      calls.close.push(agentId);
    },
    retitle: async (agentId) => {
      calls.retitle.push(agentId);
      const outcome = input.retitleResult?.(agentId) ?? true;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    markDone: async (agentId) => {
      calls.markDone.push(agentId);
    },
    logger: createTestLogger(),
  };
  return { deps, calls };
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
    expect(result).toEqual({ marked: 1, retitled: 1, failed: 0, skipped: 0 });
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
    expect(result).toEqual({ marked: 2, retitled: 0, failed: 1, skipped: 1 });
    expect(calls.markDone).toEqual(["boom", "nogen"]);
    expect(calls.close).toEqual(["boom", "nogen"]);
  });

  test("does nothing (and logs nothing) when no agent is marked", async () => {
    const { deps, calls } = setup({ records: [record("a", {})] });
    const result = await runTitleBackfill(deps);
    expect(result).toEqual({ marked: 0, retitled: 0, failed: 0, skipped: 0 });
    expect(calls.retitle).toEqual([]);
  });

  test("the done mark is not `1`, so a second run does not repeat", async () => {
    expect(TITLE_RETITLE_DONE).not.toBe("1");
  });
});
