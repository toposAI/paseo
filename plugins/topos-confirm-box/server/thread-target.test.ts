/**
 * 確認箱の「スレを開く」の宛先決め。
 *
 * 2026-10-27 本番: カードの宛先(旧総司令塔 `1800e2f7`)がアーカイブ済みで一覧に居なかったため、
 * 右カラムを開けず確認箱ごと全画面で入れ替わっていた。一覧に居なければ持ち主のスレへ振り替え、
 * 見つからなければ全画面+理由1行、を固定する。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

// クライアント側の純関数(`client/` は描画を持たない .ts だけをここから検査する)。
import {
  reportThreadTarget,
  resolveOpenThreadId,
  resolveThreadTarget,
} from "../client/thread-target.js";

const GENERAL_DEAD = "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49";
const BACKOFFICE = "b09d1682-3e1f-49de-a1ce-d55b78431bc1";
const F80 = "afe8d176-d92c-4cb2-933b-8dfe790d3c20";
const TOPOS_DEV = "5a226b97-90e8-40f3-831b-72c251deb3d7";

const live = { id: BACKOFFICE, archivedAt: null, status: "running" };
const f80 = { id: F80, archivedAt: null, status: "running" };
const toposDev = { id: TOPOS_DEV, archivedAt: null, status: "running" };
const archived = {
  id: GENERAL_DEAD,
  archivedAt: "2026-10-26T10:51:00Z",
  status: "closed",
};

const inferDomain = (text: string): string | null => {
  if (/f-?80/i.test(text)) return "f80";
  if (/topos[-_ ]?dev/i.test(text)) return "topos_dev";
  return null;
};

describe("resolveThreadTarget", () => {
  test("宛先が一覧に居れば振り替えない", () => {
    const r = resolveThreadTarget({ target: BACKOFFICE, directory: [live] });
    assert.equal(r.agentId, BACKOFFICE);
    assert.equal(r.reason, "resolved");
    assert.equal(r.notice, null);
  });

  test("本番(2026-10-27): 総司令塔が閉じているカードは、推測せずそのまま全画面にする", () => {
    // 以前は「開ける司令塔が1本だけなら寄せる」で coordinator_backstage へ寄せていたが、
    // 寄せ先は題名と無関係の裏方スレだった(本番実測)。司令塔の束への推測寄せはやめた。
    const r = resolveThreadTarget({
      target: GENERAL_DEAD,
      title: "critique 3巡の打ち切り",
      coordinatorId: GENERAL_DEAD,
      hubIds: [GENERAL_DEAD, BACKOFFICE],
      directory: [archived, live],
    });
    assert.equal(r.agentId, GENERAL_DEAD, "宛先はそのまま(全画面で開く)");
    assert.equal(r.reason, "no-live-thread");
    assert.match(r.notice ?? "", /全画面/);
  });

  test("題名から管轄が分かれば、その領域の司令塔へ振り替える", () => {
    const r = resolveThreadTarget({
      target: GENERAL_DEAD,
      title: "F-80 まとめノートの続き",
      coordinatorId: GENERAL_DEAD,
      hubIds: [GENERAL_DEAD, TOPOS_DEV, F80],
      directory: [archived, toposDev, f80],
      inferDomain,
      domainCoordinators: { f80: F80, topos_dev: TOPOS_DEV },
    });
    assert.equal(r.agentId, F80);
    assert.equal(r.reason, "domain-coordinator");
  });

  test("総司令塔のIDが生きていれば、そこへ戻す", () => {
    const r = resolveThreadTarget({
      target: "old-id",
      title: "特別な話",
      coordinatorId: BACKOFFICE,
      hubIds: [BACKOFFICE, F80],
      directory: [live, f80],
      inferDomain,
    });
    assert.equal(r.agentId, BACKOFFICE);
    assert.equal(r.reason, "general-coordinator");
  });

  test("開ける司令塔が2本以上で持ち主が分からなければ推測しない(全画面で、理由を出す)", () => {
    const r = resolveThreadTarget({
      target: GENERAL_DEAD,
      title: "だけどどの領域でもない話",
      hubIds: [TOPOS_DEV, F80],
      directory: [archived, toposDev, f80],
      inferDomain,
    });
    assert.equal(r.agentId, GENERAL_DEAD, "宛先はそのまま(全画面で開く)");
    assert.equal(r.reason, "no-live-thread");
    assert.match(r.notice ?? "", /全画面/);
  });

  test("宛先も代わりも無ければ null を返す(開くスレなし)", () => {
    const r = resolveThreadTarget({ target: null, directory: [] });
    assert.equal(r.agentId, null);
    assert.equal(r.reason, "no-live-thread");
  });

  test("閉じたスレ(closed)は、動いている方があればそちらへ寄せる", () => {
    const closedHub = { id: F80, archivedAt: null, status: "closed" };
    const r = resolveThreadTarget({
      target: F80,
      coordinatorId: BACKOFFICE,
      hubIds: [F80, BACKOFFICE],
      directory: [closedHub, live],
    });
    assert.equal(r.agentId, BACKOFFICE);
    assert.equal(r.reason, "general-coordinator");
  });
});

describe("resolveOpenThreadId", () => {
  test("投函の thread_id をそのまま使う(thread_ref=親 があっても優先)", () => {
    const id = resolveOpenThreadId({
      threadId: BACKOFFICE,
      threadRef: { kind: "paseo_agent", id: F80 },
      agentId: null,
    });
    assert.equal(id, BACKOFFICE);
  });

  test("thread_id が無ければ従来どおり thread_ref(paseo_agent)", () => {
    assert.equal(resolveOpenThreadId({ threadRef: { kind: "paseo_agent", id: F80 } }), F80);
  });

  test("paseo_agent 以外の thread_ref は使わず、承認待ちの agentId に落ちる", () => {
    assert.equal(
      resolveOpenThreadId({
        threadRef: { kind: "vault", id: "note.md" },
        agentId: TOPOS_DEV,
      }),
      TOPOS_DEV,
    );
  });

  test("threads: の先頭からは推測しない(解釈はサーバ側の1箇所だけ。round1 F4)", () => {
    const id = resolveOpenThreadId({
      threadCandidates: [TOPOS_DEV],
      threadRef: { kind: "paseo_agent", id: F80 },
    });
    assert.equal(id, F80, "候補よりサーバが入れた threadId/thread_ref を使う");
  });

  test("何も無ければ null(宛先を決めない)", () => {
    assert.equal(resolveOpenThreadId(null), null);
    assert.equal(resolveOpenThreadId({ threadId: "  ", threadRef: null, agentId: null }), null);
  });
});

describe("resolveThreadTarget: destination(この欄に答えるスレ)", () => {
  test("topic = 投函元、destination = 親。投函元が閉じていれば親へ戻す", () => {
    const r = resolveThreadTarget({
      target: F80,
      destination: BACKOFFICE,
      directory: [{ id: F80, archivedAt: "2026-10-27T00:00:00Z", status: "closed" }, live],
    });
    assert.equal(r.agentId, BACKOFFICE);
    assert.equal(r.reason, "destination");
    assert.match(r.notice ?? "", /閉じている/);
  });

  test("topic が生きていれば親へは戻さない", () => {
    const r = resolveThreadTarget({
      target: F80,
      destination: BACKOFFICE,
      directory: [f80, live],
    });
    assert.equal(r.agentId, F80);
    assert.equal(r.reason, "resolved");
  });

  test("題名から管轄が分かるなら、親より領域司令塔を先に選ぶ(従来順を変えない)", () => {
    const r = resolveThreadTarget({
      target: "old-id",
      destination: BACKOFFICE,
      title: "F-80 まとめノートの続き",
      directory: [live, f80],
      inferDomain,
      domainCoordinators: { f80: F80 },
    });
    assert.equal(r.agentId, F80);
    assert.equal(r.reason, "domain-coordinator");
  });
});

describe("reportThreadTarget", () => {
  test("振り替え・全画面は warn、そのまま開く場合は info を1行だけ出す", () => {
    const calls: string[] = [];
    const saved = { warn: console.warn, info: console.info };
    console.warn = (m?: unknown) => void calls.push(`w:${String(m)}`);
    console.info = (m?: unknown) => void calls.push(`i:${String(m)}`);
    try {
      reportThreadTarget({
        agentId: BACKOFFICE,
        reason: "resolved",
        notice: null,
      });
      reportThreadTarget({
        agentId: BACKOFFICE,
        reason: "domain-coordinator",
        notice: "x",
      });
      reportThreadTarget({
        agentId: null,
        reason: "no-live-thread",
        notice: "x",
      });
    } finally {
      console.warn = saved.warn;
      console.info = saved.info;
    }
    assert.deepEqual(calls, [
      "i:[Plugins] Confirm box thread target: resolved",
      "w:[Plugins] Confirm box thread target: domain-coordinator",
      "w:[Plugins] Confirm box thread target: no-live-thread",
    ]);
  });
});
