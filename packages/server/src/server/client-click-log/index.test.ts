import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { registerClientClickLogRoute, sanitizeClickLogEvents } from "./index.js";

const logger = { warn: () => undefined } as unknown as pino.Logger;

let dir = "";
let server: ReturnType<express.Express["listen"]> | null = null;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "click-log-"));
});

afterEach(() => {
  server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

async function post(body: unknown): Promise<Response> {
  const app = express();
  app.use(express.json());
  registerClientClickLogRoute({
    app,
    logger,
    baseDir: dir,
    now: () => new Date("2026-11-01T01:00:00Z"),
  });
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/api/client-click-log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("client click log", () => {
  test("keeps only whitelisted fields and truncates strings (no text or input values)", () => {
    const events = sanitizeClickLogEvents([
      {
        kind: "no-click",
        t: 1,
        x: 10.4,
        y: 20,
        button: 0,
        prevented: true,
        inSidebar: true,
        text: "SECRET BODY",
        value: "typed input",
        target: {
          tag: "div",
          testId: "row",
          cls: "x".repeat(500),
          parents: ["a", "b", "c", "d"],
          innerText: "SECRET",
        },
        top: null,
      },
      { kind: "evil" },
      "junk",
    ]);
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("typed input");
    const target = events[0]?.target as { cls: string; parents: string[] };
    expect(target.cls).toHaveLength(120);
    expect(target.parents).toHaveLength(3);
  });

  test("appends a record to the daily jsonl", async () => {
    const res = await post({
      session: "s1",
      reason: "no-click",
      events: [{ kind: "click", t: 5 }],
    });
    expect(res.status).toBe(201);
    const lines = readFileSync(path.join(dir, "20261101.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ session: "s1", reason: "no-click" });
  });

  test("rejects a body with no valid events", async () => {
    const res = await post({ events: [{ kind: "nope" }] });
    expect(res.status).toBe(400);
  });
});
