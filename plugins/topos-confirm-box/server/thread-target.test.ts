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
import { reportThreadTarget, resolveThreadTarget } from "../client/thread-target.js";

const GENERAL_DEAD = "1800e2f7-63a5-40b7-9f5f-52e0ba24bb49";
const BACKOFFICE = "b09d1682-3e1f-49de-a1ce-d55b78431bc1";
const F80 = "afe8d176-d92c-4cb2-933b-8dfe790d3c20";
const TOPOS_DEV = "5a226b97-90e8-40f3-831b-72c251deb3d7";

const live = { id: BACKOFFICE, archivedAt: null, status: "running" };
const f80 = { id: F80, archivedAt: null, status: "running" };
const toposDev = { id: TOPOS_DEV, archivedAt: null, status: "running" };
const archived = { id: GENERAL_DEAD, archivedAt: "2026-10-26T10:51:00Z", status: "closed" };

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

  test("本番の失敗: アーカイブ済みの総司令塔宛でも、開けるスレを選んで全画面へ落とさない", () => {
    // 題名に領域が無く、開ける司令塔が1本だけ → その1本。
    const r = resolveThreadTarget({
      target: GENERAL_DEAD,
      title: "critique 3巡の打ち切り",
      coordinatorId: GENERAL_DEAD,
      hubIds: [GENERAL_DEAD, BACKOFFICE],
      directory: [archived, live],
    });
    assert.notEqual(r.agentId, GENERAL_DEAD);
    assert.equal(r.agentId, BACKOFFICE);
    assert.equal(r.reason, "live-coordinator");
    assert.match(r.notice ?? "", /一覧に無い/);
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

describe("reportThreadTarget", () => {
  test("振り替え・全画面は warn、そのまま開く場合は info を1行だけ出す", () => {
    const calls: string[] = [];
    const saved = { warn: console.warn, info: console.info };
    console.warn = (m?: unknown) => void calls.push(`w:${String(m)}`);
    console.info = (m?: unknown) => void calls.push(`i:${String(m)}`);
    try {
      reportThreadTarget({ agentId: BACKOFFICE, reason: "resolved", notice: null });
      reportThreadTarget({ agentId: BACKOFFICE, reason: "live-coordinator", notice: "x" });
      reportThreadTarget({ agentId: null, reason: "no-live-thread", notice: "x" });
    } finally {
      console.warn = saved.warn;
      console.info = saved.info;
    }
    assert.deepEqual(calls, [
      "i:[Plugins] Confirm box thread target: resolved",
      "w:[Plugins] Confirm box thread target: live-coordinator",
      "w:[Plugins] Confirm box thread target: no-live-thread",
    ]);
  });
});
