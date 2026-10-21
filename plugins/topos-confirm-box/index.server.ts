/**
 * 統合確認箱のサーバー側(デーモン内サブプロセスで動く)。
 *
 * やること:
 * - `topos.confirmbox.list`   … Topos の箱 + 中間形式 + Paseo の承認待ちを1つにして返す
 * - `topos.confirmbox.decide` … ユーザーの選択を `pending_user_decisions.jsonl` へ追記
 * - `topos.confirmbox.permit` … Paseo の承認待ちに答える(許可/拒否)
 *
 * **読み取りはファイル直読み**。既存のサーバー側確認箱(`/api/confirm-box/*`)は通さない
 * (HTTPのポートと認証が要るうえ、同じディレクトリを別経路で読む意味が無い)。
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  KIND_LABEL,
  compareConfirmBoxItems,
  confirmBoxCountRpc,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
  cardChatListRpc,
  cardChatSayRpc,
  priorityListRpc,
  priorityMoveRpc,
  prioritySayRpc,
} from "./shared/contract.js";
import type { ConfirmBoxItem, ConfirmBoxSourceStatus } from "./shared/contract.js";
import { appendDecision, readConfirmBox, resolveConfirmBoxDir } from "./server/box.js";
import { childThreadsListRpc } from "./shared/child-threads.js";
import { readChildThreads } from "./server/child-threads.js";
import { readCardChat, sayToCard } from "./server/cardchat.js";
import { moveProject, readLedger, readReplies, sayToLedger } from "./server/priority.js";
import { permitResponse, permitsToItems } from "./server/permits.js";
import type { PermitAgentLike } from "./server/permits.js";

export default function contribute(server: PluginServerContext) {
  async function collect(ctx: {
    paseo: { agents: { list(): Promise<{ entries: { agent: PermitAgentLike }[] }> } };
  }) {
    const dir = resolveConfirmBoxDir();
    const { items, sources, dir: readDir } = readConfirmBox(dir);

    // --- Paseo の承認待ち(実行時に引く)
    let permitItems: ConfirmBoxItem[] = [];
    let permitOk = true;
    let permitDetail = "";
    try {
      const result = await ctx.paseo.agents.list();
      permitItems = permitsToItems(result.entries.map((entry) => entry.agent));
      permitDetail = `エージェント ${result.entries.length} 件から実行時に取得`;
    } catch (error) {
      permitOk = false;
      permitDetail = `取得できません: ${(error as Error).message}`;
    }
    const permitSource: ConfirmBoxSourceStatus = {
      id: "permit",
      label: KIND_LABEL.permit,
      ok: permitOk,
      detail: permitDetail,
      count: permitItems.length,
    };

    return {
      items: [...items, ...permitItems].sort(compareConfirmBoxItems),
      sources: [...sources, permitSource],
      dir: readDir,
      generatedAt: Date.now(),
    };
  }

  server.handle(confirmBoxListRpc, async (_input, ctx) => collect(ctx));

  server.handle(childThreadsListRpc, async () => {
    const dir = resolveConfirmBoxDir();
    const { items, dir: readDir } = readConfirmBox(dir);
    return { threads: readChildThreads(dir, items), dir: readDir, generatedAt: Date.now() };
  });

  server.handle(confirmBoxCountRpc, async (_input, ctx) => {
    const { items, sources, generatedAt } = await collect(ctx);
    // 本当に未決 = 決定記録なし(approved でない)かつ選択肢がある項目(通知のみは数えない)
    const open = items.filter((i) => i.state !== "approved" && i.options.length > 0);
    return {
      open: open.length,
      blocking: open.filter((i) => i.priority === "blocking").length,
      permits: open.filter((i) => i.kind === "permit").length,
      failedSources: sources.filter((src) => !src.ok).length,
      generatedAt,
    };
  });

  server.handle(confirmBoxDecideRpc, async (input) => {
    if (!input.key) return { ok: false, message: "key が空です" };
    try {
      appendDecision(resolveConfirmBoxDir(), {
        key: input.key,
        chosen: input.chosen,
        recommended: input.recommended,
        depth: input.depth,
        reason: input.reason,
        source: input.source,
      });
      return { ok: true, message: `記録しました(${input.key} → ${input.chosen ?? "選択なし"})` };
    } catch (error) {
      return { ok: false, message: `記録できません: ${(error as Error).message}` };
    }
  });

  server.handle(confirmBoxPermitRpc, async (input, ctx) => {
    try {
      // 応答の前に**実物の承認待ちを引き直す**。理由は2つ:
      // (1) 押された actionId の `behavior` は実物にしか書かれていない(クライアントに名乗らせない)
      // (2) 既に解消済み(別画面で答えた/タイムアウト)なら、黙って成功にしない
      const result = await ctx.paseo.agents.list();
      const agent = result.entries.find((entry) => entry.agent.id === input.agentId)?.agent;
      if (!agent) {
        return { ok: false, message: "エージェントが見つかりません(アーカイブ済みかもしれません)" };
      }
      const perm = (agent.pendingPermissions ?? []).find((p) => p.id === input.requestId);
      if (!perm) {
        return { ok: false, message: "この承認待ちは既に解消されています" };
      }
      const response = permitResponse(perm, input.actionId);
      await ctx.paseo.agents
        .ref(input.agentId)
        .respondToPermission({ requestId: input.requestId, response });
      return { ok: true, message: `応答しました(${response.behavior})` };
    } catch (error) {
      return { ok: false, message: `応答できません: ${(error as Error).message}` };
    }
  });

  server.handle(priorityListRpc, async () => {
    const dir = resolveConfirmBoxDir();
    const { projects, updatedTs } = readLedger(dir);
    return { projects, replies: readReplies(dir), updatedTs };
  });

  server.handle(priorityMoveRpc, async (input) => {
    try {
      return moveProject(resolveConfirmBoxDir(), input.id, input.toRank);
    } catch (error) {
      return { ok: false, message: `並べ替えできません: ${(error as Error).message}` };
    }
  });

  server.handle(prioritySayRpc, async (input) => {
    try {
      return sayToLedger(resolveConfirmBoxDir(), input.text);
    } catch (error) {
      return { ok: false, message: `送れません: ${(error as Error).message}` };
    }
  });

  server.handle(cardChatListRpc, async (input) => {
    try {
      return { messages: readCardChat(resolveConfirmBoxDir(), input.key) };
    } catch {
      return { messages: [] };
    }
  });

  server.handle(cardChatSayRpc, async (input) => {
    try {
      return sayToCard(resolveConfirmBoxDir(), input.key, input.text);
    } catch (error) {
      return { ok: false, message: `送れません: ${(error as Error).message}` };
    }
  });

  return () => {};
}
