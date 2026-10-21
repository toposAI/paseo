import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  selectChatTranscript,
  type ConfirmBoxThreadGateway,
  type ConfirmBoxTimelineItem,
} from "./chat.js";
import { decidePush } from "./push-policy.js";
import { registerConfirmBoxRoutes } from "./routes.js";
import { ConfirmBoxService } from "./service.js";
import { ConfirmBoxStore, CHAT_ACK_TEXT } from "./store.js";

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

/** 2026-10-21追加キーを持つ item 行(Python側の新形式)。 */
function pyItemFull(id: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    t: "item",
    id,
    ts: NOW,
    urgency: "normal",
    source: "x.py",
    subject: `s-${id}`,
    body: "",
    origin: "python",
    priority: "normal",
    subrank: 0,
    group: null,
    summary: `sum-${id}`,
    background: `bg-${id}`,
    thread_ref: null,
    stopped_count: 0,
    options: [],
    recommended: null,
    key: null,
    ...over,
  })}\n`;
}

function ackLine(id: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ t: "ack", id, ts: NOW, action: "read", ...over })}\n`;
}

describe("ConfirmBoxStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "confirm-box-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("Pythonが書いたitem行を取り込み、未読/緊急を集計する", () => {
    // ts を分けるのは並び順のキーが `ts降順` のため(同一tsの同時刻タイは投函順=古い順に落ちる。
    // Python側 sort_items() の安定ソートと同じ挙動)。
    appendFileSync(eventsFile(dir), pyItem("a", "urgent", NOW - 1000) + pyItem("b", "normal", NOW));
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
      pyItem("a", "urgent", NOW - 2000) +
        pyItem("b", "normal", NOW - 1000) +
        pyItem("c", "normal", NOW),
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

  test("古いitem(追加キー無し)は既定値で補完して読む", () => {
    appendFileSync(eventsFile(dir), pyItem("old", "normal"));
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.list("all", 10)[0]).toMatchObject({
      priority: "normal",
      subrank: 0,
      group: null,
      summary: "",
      background: "",
      threadRef: null,
      stoppedCount: 0,
      options: [],
      recommended: null,
      key: null,
      depth: null,
      chosen: null,
      chatQuestion: null,
    });
  });

  test("並び順は priority → subrank → group → ts降順(Python sort_items と同じ)", () => {
    appendFileSync(
      eventsFile(dir),
      // priority: blocking > design > normal > info
      pyItemFull("info1", { priority: "info", ts: 900 }) +
        pyItemFull("block1", { priority: "blocking", ts: 100 }) +
        pyItemFull("normal1", { priority: "normal", ts: 500 }) +
        pyItemFull("design1", { priority: "design", ts: 300 }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.list("all", 10).map((i) => i.id)).toEqual([
      "block1",
      "design1",
      "normal1",
      "info1",
    ]);
  });

  test("同じpriorityでは subrank 昇順、同じsubrankでは ts 降順", () => {
    appendFileSync(
      eventsFile(dir),
      pyItemFull("late", { priority: "info", subrank: 2, ts: 900 }) +
        pyItemFull("newer", { priority: "info", subrank: 0, ts: 900 }) +
        pyItemFull("older", { priority: "info", subrank: 0, ts: 100 }) +
        pyItemFull("neg", { priority: "info", subrank: -1, ts: 1 }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.list("all", 10).map((i) => i.id)).toEqual(["neg", "newer", "older", "late"]);
  });

  test("同じgroupは一覧で連続する(背景を1回読めば済むように)", () => {
    appendFileSync(
      eventsFile(dir),
      pyItemFull("g1a", { priority: "info", subrank: 1, group: "ha-sec9", ts: 100 }) +
        pyItemFull("solo", { priority: "info", subrank: 1, ts: 900 }) +
        pyItemFull("g1b", { priority: "info", subrank: 1, group: "ha-sec9", ts: 500 }) +
        pyItemFull("g2", { priority: "info", subrank: 1, group: "zz", ts: 700 }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    // group無し(新しい順)→ ha-sec9 の2件が連続 → zz
    expect(store.list("all", 10).map((i) => i.id)).toEqual(["solo", "g1b", "g1a", "g2"]);
  });

  test("ackのdepth/chosen/chat_questionが畳み込まれる", () => {
    appendFileSync(
      eventsFile(dir),
      pyItemFull("a", {
        options: [
          { id: "yes", label: "やる" },
          { id: "no", label: "やめる" },
        ],
        recommended: "yes",
      }) + pyItemFull("b", { options: [] }),
    );
    appendFileSync(
      eventsFile(dir),
      ackLine("a", {
        action: "approve",
        depth: "chat",
        chosen: "yes",
        chat_question: "J1とJ2の違いは?",
      }) +
        // 選択肢に無いidは記録しない(タップしていない値を「選んだ選択肢」にしない)
        ackLine("b", { action: "approve", depth: "bogus", chosen: "yes" }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    const byId = new Map(store.list("all", 10).map((i) => [i.id, i]));
    expect(byId.get("a")).toMatchObject({
      state: "approved",
      depth: "chat",
      chosen: "yes",
      chatQuestion: "J1とJ2の違いは?",
    });
    expect(byId.get("b")).toMatchObject({ depth: null, chosen: null, chatQuestion: null });
  });

  test("浅いackで深いdepthを上書きしない(指標が甘くならない)", () => {
    appendFileSync(eventsFile(dir), pyItemFull("a"));
    appendFileSync(
      eventsFile(dir),
      ackLine("a", { depth: "chat", ts: NOW }) + ackLine("a", { depth: "list", ts: NOW + 1 }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.list("all", 10)[0]!.depth).toBe("chat");
  });

  test("ack(depth/chosen/chatQuestion)が契約どおりの行を書く", () => {
    appendFileSync(eventsFile(dir), pyItemFull("a", { options: [{ id: "yes", label: "やる" }] }));
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(
      store.ack("a", "approve", { depth: "background", chosen: "yes", chatQuestion: "なぜ?" }),
    ).toBe(true);
    expect(store.ack("nope", "read", { depth: "chat" })).toBe(false);
    const line = JSON.parse(readFileSync(eventsFile(dir), "utf8").trim().split("\n").pop()!);
    // イベントの形はPython側と共有する契約なので chat_question だけ snake_case
    expect(line).toMatchObject({
      t: "ack",
      id: "a",
      action: "approve",
      depth: "background",
      chosen: "yes",
      chat_question: "なぜ?",
    });
    expect(store.list("all", 10)[0]).toMatchObject({ depth: "background", chosen: "yes" });
  });

  test("recordChatQuestion が契約どおりの行を書き、chatEntries に畳み込まれる", () => {
    appendFileSync(
      eventsFile(dir),
      pyItemFull("a", { key: "p22-1", thread_ref: { kind: "paseo_agent", id: "ag1" } }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    const first = store.recordChatQuestion("a", "J1とJ2の違いは?");
    expect(first).toBe("cbx-a-1");
    // 空の質問・存在しない項目では記録しない
    expect(store.recordChatQuestion("a", "   ")).toBeNull();
    expect(store.recordChatQuestion("nope", "x")).toBeNull();
    const lines = readFileSync(eventsFile(dir), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // イベントの形はPython側と共有する契約なので client_message_id だけ snake_case
    expect(lines[lines.length - 2]).toMatchObject({
      t: "chat",
      id: "a",
      key: "p22-1",
      ts: NOW,
      question: "J1とJ2の違いは?",
      client_message_id: "cbx-a-1",
    });
    // 受領は**同じwriteの直後**に付く(fail-open。UIが即座に1行返す=無反応に見せない)
    expect(lines[lines.length - 1]).toMatchObject({
      t: "reply",
      id: "a",
      key: "p22-1",
      ts: NOW,
      re: "cbx-a-1",
      by: "ack",
      text: CHAT_ACK_TEXT,
    });
    expect(store.chatEntries("a")).toEqual([
      { itemId: "a", ts: NOW, question: "J1とJ2の違いは?", clientMessageId: "cbx-a-1" },
    ]);
    expect(store.replyEntries("a")).toEqual([
      { itemId: "a", ts: NOW, re: "cbx-a-1", by: "ack", text: CHAT_ACK_TEXT },
    ]);
    // 別インスタンス(デーモン再起動)でも同じ状態に畳み込まれる
    const fresh = new ConfirmBoxStore(dir, () => NOW);
    fresh.refresh();
    expect(fresh.chatEntries("a")).toHaveLength(1);
    expect(fresh.replyEntries("a")).toEqual([
      { itemId: "a", ts: NOW, re: "cbx-a-1", by: "ack", text: CHAT_ACK_TEXT },
    ]);
    // 同じ項目に複数回聞ける(連番で対応付けを一意にする)
    expect(fresh.recordChatQuestion("a", "もう一つ")).toBe("cbx-a-2");
    expect(fresh.chatEntries("a").map((c) => c.question)).toEqual(["J1とJ2の違いは?", "もう一つ"]);
  });

  test("chat行: itemが無い/同じclient_message_idは畳み込まない", () => {
    const chatLine = (id: string, cid: string) =>
      `${JSON.stringify({ t: "chat", id, ts: NOW, question: "q", client_message_id: cid })}\n`;
    appendFileSync(eventsFile(dir), pyItemFull("a"));
    // item より前の chat 行は捨てる(先に item が要る)
    appendFileSync(eventsFile(dir), chatLine("zzz", "cbx-zzz-1"));
    appendFileSync(eventsFile(dir), chatLine("a", "cbx-a-1") + chatLine("a", "cbx-a-1"));
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    expect(store.chatEntries("a")).toHaveLength(1);
    expect(store.chatEntries("zzz")).toEqual([]);
  });

  test("reply行: 返事を畳み込み、同じ(re,by)は二重に数えない", () => {
    const replyLine = (o: Record<string, unknown>) =>
      `${JSON.stringify({ t: "reply", ts: NOW, ...o })}\n`;
    appendFileSync(eventsFile(dir), pyItemFull("a"));
    appendFileSync(
      eventsFile(dir),
      `${JSON.stringify({ t: "chat", id: "a", ts: NOW, question: "q", client_message_id: "cbx-a-1" })}\n`,
    );
    appendFileSync(
      eventsFile(dir),
      // 受領は同じ (re, by) で2回来ても1本。ワーカーの本回答は by が違うので別行として残る。
      replyLine({ id: "a", re: "cbx-a-1", by: "ack", text: "受け取りました" }) +
        replyLine({ id: "a", re: "cbx-a-1", by: "ack", text: "受け取りました" }) +
        replyLine({ re: "cbx-a-1", by: "worker", text: "J1は…" }) +
        // 項目IDも対応する質問も無い返事は捨てる(どの項目にも見せない)
        replyLine({ re: "cbx-unknown-9", by: "worker", text: "迷子" }) +
        // 本文が空/`re` が無い行は捨てる
        replyLine({ id: "a", re: "cbx-a-1", by: "fallback", text: "  " }) +
        replyLine({ id: "a", by: "worker", text: "re なし" }),
    );
    const store = new ConfirmBoxStore(dir, () => NOW);
    store.refresh();
    // id を書かない行でも `re` から質問→項目へ辿れる(プラグインの保留中項目など)
    expect(store.replyEntries("a")).toEqual([
      { itemId: "a", ts: NOW, re: "cbx-a-1", by: "ack", text: "受け取りました" },
      { itemId: "a", ts: NOW, re: "cbx-a-1", by: "worker", text: "J1は…" },
    ]);
    expect(store.replyEntries("zzz")).toEqual([]);
    // 再読み込みで増えない(デーモン再起動・ファイル切り詰めの保険)
    store.refresh();
    expect(store.replyEntries("a")).toHaveLength(2);
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
    priority: "normal" as const,
    subrank: 0,
    group: null,
    summary: "",
    background: "",
    threadRef: null,
    stoppedCount: 0,
    options: [],
    recommended: null,
    key: null,
    depth: null,
    chosen: null,
    chatQuestion: null,
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

describe("selectChatTranscript", () => {
  test("箱が付けたclientMessageIdを起点に、その後の発言だけを拾う", () => {
    const timeline: ConfirmBoxTimelineItem[] = [
      { type: "user_message", text: "前の話" },
      { type: "assistant_message", text: "前の返答" },
      { type: "user_message", text: "J1とJ2の違いは?", clientMessageId: "cbx-a-1" },
      { type: "assistant_message", text: "J1は…" },
    ];
    expect(selectChatTranscript(timeline, ["cbx-a-1"])).toEqual([
      { role: "user", text: "J1とJ2の違いは?" },
      { role: "assistant", text: "J1は…" },
    ]);
  });

  test("箱の質問が2つあれば、両方のやり取りを出す", () => {
    const timeline: ConfirmBoxTimelineItem[] = [
      { type: "user_message", text: "q1", clientMessageId: "cbx-a-1" },
      { type: "assistant_message", text: "a1" },
      { type: "user_message", text: "q2", clientMessageId: "cbx-a-2" },
      { type: "assistant_message", text: "a2" },
    ];
    expect(selectChatTranscript(timeline, ["cbx-a-1", "cbx-a-2"]).map((t) => t.text)).toEqual([
      "q1",
      "a1",
      "q2",
      "a2",
    ]);
  });

  test("起点が無ければ空を返す(推測で別の返答を出さない)", () => {
    // デーモン再起動後は元スレがメモリから消えて、タイムラインに箱の質問が残っていない
    const timeline: ConfirmBoxTimelineItem[] = [
      { type: "assistant_message", text: "無関係な返答" },
    ];
    expect(selectChatTranscript(timeline, ["cbx-a-1"])).toEqual([]);
    // 質問を1つも送っていない項目でも空
    expect(selectChatTranscript(timeline, [])).toEqual([]);
  });
});

describe("confirm-box routes", () => {
  let dir: string;
  let server: ReturnType<express.Express["listen"]>;
  let base: string;
  let sent: Array<{ agentId: string; question: string; clientMessageId: string }>;
  let timeline: ConfirmBoxTimelineItem[];
  let timelineThrows: boolean;
  const json = { "Content-Type": "application/json" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "confirm-box-http-"));
    writeFileSync(eventsFile(dir), pyItem("a", "urgent"));
    appendFileSync(
      eventsFile(dir),
      pyItemFull("d", { options: [{ id: "yes", label: "やる" }], recommended: "yes" }),
    );
    sent = [];
    timeline = [];
    timelineThrows = false;
    // bootstrap.ts が渡す gateway の代役(sendPromptToAgent と AgentManager を包んだもの)
    const gateway: ConfirmBoxThreadGateway = {
      send: async (input) => void sent.push(input),
      timeline: async () => {
        if (timelineThrows) throw new Error("Unknown agent");
        return timeline;
      },
    };
    const app = express();
    app.use(express.json());
    registerConfirmBoxRoutes({
      app,
      store: new ConfirmBoxStore(dir, () => NOW),
      getHeartbeatAgeMs: () => 5,
      getServerId: () => "srv_test123",
      getThreadGateway: () => gateway,
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
    const html = await page.text();
    expect(html).toContain("確認箱");
    // 4段の開示(題名だけ → 選択肢+summary → 背景 → チャット欄)がUIに載っている
    expect(html).toContain("背景を開く");
    expect(html).toContain("チャットで聞く");
    expect(html).toContain("chat_question");
    // チャット欄(A案)と、長い相談用の「元スレを開く」導線
    expect(html).toContain("送る");
    expect(html).toContain("元スレを開く");
    expect(html).toContain("srv_test123"); // 元スレの直リンク /h/<serverId>/agent/<id>
    // 元スレの無い項目でも送れる(質問は記録され、応答ワーカーが返す。2026-10-22)
    expect(html).toContain(
      "この項目には元スレの送り先がありませんが、書いた内容への返事はここに出ます。",
    );
    expect(html).toContain("replies = d.replies || []");

    expect(await (await fetch(`${base}/summary`)).json()).toEqual({
      unread: 2,
      urgentUnread: 1,
      total: 2,
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
    expect(items.items).toHaveLength(3);

    const ack = await fetch(`${base}/items/a/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(ack.status).toBe(200);
    expect((await fetch(`${base}/items/zzz/ack`, { method: "POST" })).status).toBe(404);

    // depth/chosen/chat_question がルートを通って書かれる(UIが「どこまで開いて決めたか」を載せる経路)
    const decided = await fetch(`${base}/items/d/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        depth: "chat",
        chosen: "yes",
        chat_question: "なぜ?",
      }),
    });
    expect(decided.status).toBe(200);
    const listed = (await (await fetch(`${base}/items?view=all`)).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(listed.items.find((i) => i.id === "d")).toMatchObject({
      state: "approved",
      depth: "chat",
      chosen: "yes",
      chatQuestion: "なぜ?",
    });

    const all = (await (await fetch(`${base}/ack-all`, { method: "POST" })).json()) as {
      acked: number;
    };
    expect(all.acked).toBe(1);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      status: "ok",
      heartbeatAgeMs: 5,
    });
  });

  test("チャット欄: 質問を元スレへ送り、返答を取り込む", async () => {
    appendFileSync(
      eventsFile(dir),
      pyItemFull("c", { thread_ref: { kind: "paseo_agent", id: "ag-1" } }),
    );
    const posted = await fetch(`${base}/items/c/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ question: "J1とJ2の違いは?" }),
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({
      ok: true,
      sent: true,
      clientMessageId: "cbx-c-1",
    });
    // 元スレへは agent id で送られる(箱の質問は人間のユーザーメッセージとして見える)
    expect(sent).toEqual([
      { agentId: "ag-1", question: "J1とJ2の違いは?", clientMessageId: "cbx-c-1" },
    ]);

    // 元スレ側に、その clientMessageId の user_message と、その後の返答が現れる
    timeline = [
      { type: "user_message", text: "前の話" },
      { type: "assistant_message", text: "前の返答" },
      { type: "user_message", text: "J1とJ2の違いは?", clientMessageId: "cbx-c-1" },
      { type: "assistant_message", text: "J1は…" },
    ];
    const got = (await (await fetch(`${base}/items/c/chat`)).json()) as {
      questions: Array<{ question: string }>;
      replies: Array<{ re: string; by: string; text: string }>;
      turns: Array<{ role: string; text: string }>;
      canSend: boolean;
      transcriptError: string | null;
    };
    expect(got.canSend).toBe(true);
    expect(got.questions.map((q) => q.question)).toEqual(["J1とJ2の違いは?"]);
    // 受領は箱が同じwriteで書く(応答ワーカーの周期を待たずにUIが1行返す)
    expect(got.replies).toMatchObject([{ re: "cbx-c-1", by: "ack", text: CHAT_ACK_TEXT }]);
    // 箱の質問より前のやり取りは出さない(箱は「聞いて返ってきた所」だけ見せる)
    expect(got.turns).toEqual([
      { role: "user", text: "J1とJ2の違いは?" },
      { role: "assistant", text: "J1は…" },
    ]);
    expect(got.transcriptError).toBeNull();

    // 空の質問は400、存在しない項目は404
    const blank = await fetch(`${base}/items/c/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ question: "   " }),
    });
    expect(blank.status).toBe(400);
    const missing = await fetch(`${base}/items/zzz/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ question: "x" }),
    });
    expect(missing.status).toBe(404);
    expect((await fetch(`${base}/items/zzz/chat`)).status).toBe(404);

    // タイムラインが読めないときは、推測で返答を出さず理由だけ返す
    timelineThrows = true;
    const failed = (await (await fetch(`${base}/items/c/chat`)).json()) as {
      turns: unknown[];
      transcriptError: string;
    };
    expect(failed.turns).toEqual([]);
    expect(failed.transcriptError).toContain("Unknown agent");
  });

  test("チャット欄: 元スレがPaseoのスレッドでなければ送らず、質問文だけ残す", async () => {
    appendFileSync(
      eventsFile(dir),
      pyItemFull("n", { thread_ref: { kind: "topos_thread", id: "t-1" } }),
    );
    const r = await fetch(`${base}/items/n/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ question: "これはどうする?" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, sent: false, reason: "no_thread" });
    expect(sent).toEqual([]);
    const got = (await (await fetch(`${base}/items/n/chat`)).json()) as {
      canSend: boolean;
      questions: unknown[];
      replies: Array<{ by: string; text: string }>;
      turns: unknown[];
    };
    expect(got.canSend).toBe(false);
    // 送れなくても質問文は学習ログの主原料なので残す
    expect(got.questions).toHaveLength(1);
    expect(got.turns).toEqual([]);
    // 元スレが無くても受領は返る(=画面が無反応にならない)。本回答は応答ワーカーが書く。
    expect(got.replies).toMatchObject([{ re: "cbx-n-1", by: "ack", text: CHAT_ACK_TEXT }]);
  });
});
