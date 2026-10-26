import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

import { runArchiveCommand } from "./archive.js";

const makeAgent = (id: string, status: "idle" | "running" | "closed" = "idle") => ({
  id,
  status,
  archivedAt: null as string | null,
  cwd: "/tmp/project",
});
// Newest first, like the daemon's default updated_at ordering.
let daemonAgents: ReturnType<typeof makeAgent>[] = [];
const toEntry = (agent: ReturnType<typeof makeAgent>) => ({ agent });
// The fake daemon pages agents two at a time.
const agentPage = (cursor: string | undefined) => {
  const start = Number(cursor ?? 0);
  const end = start + 2;
  return {
    entries: daemonAgents.slice(start, end).map(toEntry),
    pageInfo: { nextCursor: end < daemonAgents.length ? String(end) : null },
  };
};
const fetchAgents = vi.fn(async (options: { page?: { cursor?: string } }) =>
  agentPage(options.page?.cursor),
);
const archiveAgent = vi.fn(async (_agentId: string) => ({
  archivedAt: "2026-10-24T00:00:00Z",
}));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon: vi.fn(async () => ({
    fetchAgents,
    archiveAgent,
    close,
  })),
}));

describe("runArchiveCommand", () => {
  beforeEach(() => {
    daemonAgents = [];
    fetchAgents.mockClear();
    archiveAgent.mockClear();
  });

  it("resolves an agent that only appears on a later page", async () => {
    const oldAgent = makeAgent("6ab38710-746d-4469-af95-77d6ff6f98be", "closed");
    daemonAgents = [
      makeAgent("11111111-1111-4111-8111-111111111111", "closed"),
      makeAgent("22222222-2222-4222-8222-222222222222", "closed"),
      oldAgent,
    ];

    const result = await runArchiveCommand("6ab3871", { daemonTarget }, {} as never);

    expect(fetchAgents).toHaveBeenCalledTimes(2);
    expect(archiveAgent).toHaveBeenCalledWith(oldAgent.id);
    expect(result.data).toEqual({
      agentId: oldAgent.id,
      status: "archived",
      archivedAt: "2026-10-24T00:00:00Z",
    });
  });

  it("still rejects an ID that is on no page", async () => {
    daemonAgents = [
      makeAgent("11111111-1111-4111-8111-111111111111", "closed"),
      makeAgent("22222222-2222-4222-8222-222222222222", "closed"),
      makeAgent("33333333-3333-4333-8333-333333333333", "closed"),
    ];

    await expect(runArchiveCommand("1289ac4", { daemonTarget }, {} as never)).rejects.toMatchObject(
      { code: "AGENT_NOT_FOUND" },
    );
    expect(fetchAgents).toHaveBeenCalledTimes(2);
    expect(archiveAgent).not.toHaveBeenCalled();
  });

  it("asks for --force instead of archiving a running agent found on a later page", async () => {
    daemonAgents = [
      makeAgent("11111111-1111-4111-8111-111111111111", "closed"),
      makeAgent("22222222-2222-4222-8222-222222222222", "closed"),
      makeAgent("44444444-4444-4444-8444-444444444444", "running"),
    ];

    await expect(runArchiveCommand("4444444", { daemonTarget }, {} as never)).rejects.toMatchObject(
      { code: "AGENT_RUNNING" },
    );
    expect(archiveAgent).not.toHaveBeenCalled();
  });
});
