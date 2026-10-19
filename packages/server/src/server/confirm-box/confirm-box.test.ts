import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { decidePush } from "./push-policy.js";
import { registerConfirmBoxRoutes } from "./routes.js";
import { ConfirmBoxService } from "./service.js";
import { ConfirmBoxStore } from "./store.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime();
const eventsFile = (dir: string) => path.join(dir, "events-202610.jsonl");

function pyItem(id: string, urgency: string, ts = NOW, subject = `s-${id}`): string {
  // Python notify_box.py が書く行と同じ形(データ契約)
  return `${JSON.stringify({ t: "item", id, ts, urgency, source: "x.py", subject, body: "b", origin: "python" })}\n`;
}

describe("ConfirmBoxStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "confirm-box-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("Pythonが書いたitem行を取り込み、未読/緊急を集計する", () => {
    appendFileSync(eventsFile(dir), pyItem("a", "urgent") + pyItem("b", "normal"));
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.summary()).toEqual({ unread: 2, urgentUnread: 1, total: 2 });
    expect(store.list("active", 10).map((i) => i.id)).toEqual(["b", "a"]);
  });

  test("追記分だけ増分で読み、途中書きの行は次回に持ち越す", () => {
    const store = new ConfirmBoxStore(dir, () => NOW);
    appendFileSync(eventsFile(dir), pyItem("a", "normal"));
    expect(store.refresh()).toBe(1);
    const second = pyItem("b", "normal");
    appendFileSync(eventsFile(dir), second.slice(0, 20));
    expect(store.refresh()).toBe(0);
    appendFileSync(eventsFile(dir), second.slice(20));
    expect(store.refresh()).toBe(1);
    expect(store.summary().total).toBe(2);
  });

  test("壊れた行・未知イベントは無視する", () => {
    appendFileSync(eventsFile(dir), `not json\n{"t":"zzz"}\n${pyItem("a", "normal")}`);
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.summary().total).toBe(1);
  });

  test("ack(read/approve)とackallが畳み込まれる", () => {
    appendFileSync(
      eventsFile(dir),
      pyItem("a", "urgent") + pyItem("b", "normal") + pyItem("c", "normal"),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.ack("a", "approve")).toBe(true);
    expect(store.ack("nope", "read")).toBe(false);
    expect(store.ackAll()).toBe(2);
    expect(store.summary().unread).toBe(0);
    expect(store.list("all", 10).map((i) => i.state)).toEqual(["read", "read", "approved"]);
    // 別インスタンス(デーモン再起動)でも同じ状態に畳み込まれる
    const fresh = new ConfirmBoxStore(dir, () => NOW);
    fresh.refresh();
    expect(fresh.summary().unread).toBe(0);
  });

  test("addItem(外部受信)はPython側が読める契約形式で追記される", () => {
    const store = new ConfirmBoxStore(dir, () => NOW);
    const item = store.addItem({ subject: "hello", urgency: "urgent", source: "ext" });
    const line = JSON.parse(readFileSync(eventsFile(dir), "utf8").trim());
    expect(line).toMatchObject({
      t: "item",
      id: item.id,
      urgency: "urgent",
      origin: "api",
      ts: NOW,
    });
  });

  test("heartbeat.json を原子的に書く", () => {
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.writeHeartbeat({
      ts: NOW,
      pid: 1,
      version: "v",
      lastScanAt: NOW,
      lastPushAt: null,
      unpushedUrgent: 0,
    });
    expect(JSON.parse(readFileSync(path.join(dir, "heartbeat.json"), "utf8")).ts).toBe(NOW);
  });
});

describe("decidePush", () => {
  const item = (
    id: string,
    over: Partial<Parameters<typeof decidePush>[0]["items"][number]> = {},
  ) => ({
    id,
    ts: NOW - 1000,
    urgency: "urgent" as const,
    source: "x",
    subject: `subj-${id}`,
    body: "secret body",
    origin: "python",
    state: "new" as const,
    pushedAt: null,
    ...over,
  });

  test("緊急・未読・未pushだけをまとめて1通にし、本文は件名のみ", () => {
    const d = decidePush({
      items: [item("a"), item("b"), item("n", { urgency: "normal" })],
      now: NOW,
      pushTimes: [],
    });
    expect(d?.ids).toEqual(["a", "b"]);
    expect(d?.payload.body).toBe("subj-a / subj-b");
    expect(JSON.stringify(d)).not.toContain("secret body");
  });

  test("既読・push済み・古い項目は対象外", () => {
    expect(
      decidePush({
        items: [
          item("r", { state: "read" }),
          item("p", { pushedAt: 1 }),
          item("old", { ts: NOW - 7 * 3600_000 }),
        ],
        now: NOW,
        pushTimes: [],
      }),
    ).toBeNull();
  });

  test("5分未満の間隔・1時間6回超ではpushしない", () => {
    expect(decidePush({ items: [item("a")], now: NOW, pushTimes: [NOW - 60_000] })).toBeNull();
    const six = Array.from({ length: 6 }, (_, i) => NOW - (i + 6) * 60_000);
    expect(decidePush({ items: [item("a")], now: NOW, pushTimes: six })).toBeNull();
    expect(
      decidePush({ items: [item("a")], now: NOW, pushTimes: [NOW - 10 * 60_000] }),
    ).not.toBeNull();
  });

  test("4件以上は先頭3件+他N件に要約", () => {
    const items = ["a", "b", "c", "d", "e"].map((id) => item(id));
    expect(decidePush({ items, now: NOW, pushTimes: [] })?.payload.body).toBe(
      "subj-c / subj-d / subj-e 他2件",
    );
  });
});

describe("ConfirmBoxService", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "confirm-box-svc-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("tickで取り込み→緊急push→heartbeat更新。同じ項目を二重pushしない", async () => {
    appendFileSync(
      eventsFile(dir),
      pyItem("a", "urgent", NOW - 1000) + pyItem("b", "normal", NOW - 1000),
    );
    const sent: Array<{ title: string; body: string }> = [];
    const service = new ConfirmBoxService({
      store: new ConfirmBoxStore(dir, () => NOW),
      logger: createLogger(),
      version: "test",
      now: () => NOW,
      getPushSender: () => ({ send: async (p) => void sent.push(p) }),
    });
    await service.tick();
    await service.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("緊急 1件");
    const hb = JSON.parse(readFileSync(path.join(dir, "heartbeat.json"), "utf8"));
    expect(hb).toMatchObject({ ts: NOW, version: "test", unpushedUrgent: 0 });
    expect(service.heartbeatAgeMs()).toBe(0);
  });

  test("pushSenderが未解決でもheartbeatは書く", async () => {
    const service = new ConfirmBoxService({
      store: new ConfirmBoxStore(dir, () => NOW),
      logger: createLogger(),
      version: "test",
      now: () => NOW,
      getPushSender: () => undefined,
    });
    await service.tick();
    expect(JSON.parse(readFileSync(path.join(dir, "heartbeat.json"), "utf8")).ts).toBe(NOW);
  });
});

describe("confirm-box routes", () => {
  let dir: string;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "confirm-box-http-"));
    writeFileSync(eventsFile(dir), pyItem("a", "urgent"));
    const app = express();
    app.use(express.json());
    registerConfirmBoxRoutes({
      app,
      store: new ConfirmBoxStore(dir, () => NOW),
      getHeartbeatAgeMs: () => 5,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/confirm-box`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  test("ページ・summary・items・ack・ack-all・外部受信・health", async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("確認箱");

    expect(await (await fetch(`${base}/summary`)).json()).toEqual({
      unread: 1,
      urgentUnread: 1,
      total: 1,
    });

    const created = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "外部から", urgency: "normal" }),
    });
    expect(created.status).toBe(201);
    const bad = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "" }),
    });
    expect(bad.status).toBe(400);

    const items = (await (await fetch(`${base}/items?view=active`)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(items.items).toHaveLength(2);

    const ack = await fetch(`${base}/items/a/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(ack.status).toBe(200);
    expect((await fetch(`${base}/items/zzz/ack`, { method: "POST" })).status).toBe(404);

    const all = (await (await fetch(`${base}/ack-all`, { method: "POST" })).json()) as {
      acked: number;
    };
    expect(all.acked).toBe(1);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      status: "ok",
      heartbeatAgeMs: 5,
    });
  });
});
