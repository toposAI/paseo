import { describe, expect, it } from "vitest";

import { buildPresenceSnapshot, parseWithinSeconds } from "./snapshot.js";

const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000);

describe("buildPresenceSnapshot", () => {
  it("端末が無ければ present=false(withinSeconds指定時)・時刻は null", () => {
    const s = buildPresenceSnapshot([], NOW, 600);
    expect(s.clientCount).toBe(0);
    expect(s.lastActivityAt).toBeNull();
    expect(s.lastVisibleActivityAt).toBeNull();
    expect(s.present).toBe(false);
  });

  it("withinSeconds 未指定なら present は null", () => {
    const s = buildPresenceSnapshot(
      [{ deviceType: "web", appVisible: true, lastActivityAt: at(5), focusedAgentId: null }],
      NOW,
    );
    expect(s.present).toBeNull();
  });

  it("見えていて最近触った端末があれば present=true", () => {
    const s = buildPresenceSnapshot(
      [
        { deviceType: "web", appVisible: false, lastActivityAt: at(1), focusedAgentId: null },
        { deviceType: "mobile", appVisible: true, lastActivityAt: at(100), focusedAgentId: "a" },
      ],
      NOW,
      600,
    );
    expect(s.present).toBe(true);
    expect(s.lastActivityAt).toBe(at(1).toISOString());
    expect(s.lastVisibleActivityAt).toBe(at(100).toISOString());
  });

  it("開きっぱなし(見えているが操作が古い)と、最近触ったが見えていない端末は離席扱い", () => {
    const s = buildPresenceSnapshot(
      [
        { deviceType: "web", appVisible: true, lastActivityAt: at(3000), focusedAgentId: null },
        { deviceType: "mobile", appVisible: false, lastActivityAt: at(10), focusedAgentId: null },
      ],
      NOW,
      600,
    );
    expect(s.present).toBe(false);
  });

  it("未来の時刻は now に丸め idleSeconds は負にならない", () => {
    const s = buildPresenceSnapshot(
      [{ deviceType: "web", appVisible: true, lastActivityAt: at(-30), focusedAgentId: null }],
      NOW,
      60,
    );
    expect(s.clients[0]!.idleSeconds).toBe(0);
  });
});

describe("parseWithinSeconds", () => {
  it("正常値だけ数にし、それ以外は null", () => {
    expect(parseWithinSeconds("600")).toBe(600);
    expect(parseWithinSeconds("0")).toBe(0);
    expect(parseWithinSeconds("")).toBeNull();
    expect(parseWithinSeconds("abc")).toBeNull();
    expect(parseWithinSeconds("-1")).toBeNull();
    expect(parseWithinSeconds(undefined)).toBeNull();
    expect(parseWithinSeconds("99999999")).toBeNull();
  });
});
