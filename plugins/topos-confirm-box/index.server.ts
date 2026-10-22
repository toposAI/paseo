/**
 * 統合確認箱のサーバー側(デーモン内サブプロセスで動く)。
 *
 * やること:
 * - `topos.confirmbox.list`   … Topos の箱 + 中間形式 + Paseo の承認待ちを1つにして返す
 * - `topos.confirmbox.decide` … ユーザーの選択を `pending_user_decisions.jsonl` へ追記
 * - `topos.confirmbox.permit` … Paseo の承認待ちに答える(許可/拒否・質問への回答)
 *
 * **読み取りはファイル直読み**。既存のサーバー側確認箱(`/api/confirm-box/*`)は通さない
 * (HTTPのポートと認証が要るうえ、同じディレクトリを別経路で読む意味が無い)。
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  KIND_LABEL,
  compareConfirmBoxItems,
  confirmBoxAckAllRpc,
  confirmBoxAckRpc,
  confirmBoxCountRpc,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
  cardChatListRpc,
  cardChatSayRpc,
  countUnreadNotifications,
  priorityListRpc,
  priorityMoveRpc,
  prioritySayRpc,
} from "./shared/contract.js";
import { appendAck, appendAckAll } from "./server/ack.js";
import { feedbackReportsListRpc, countNewReports } from "./shared/feedback.js";
import { readFeedbackReports } from "./server/feedback.js";
import type { ConfirmBoxItem, ConfirmBoxSourceStatus } from "./shared/contract.js";
import { appendDecision, readConfirmBox, resolveConfirmBoxDir } from "./server/box.js";
import { childThreadsListRpc, childThreadsSetOrderRpc } from "./shared/child-threads.js";
import {
  readChildThreadOrder,
  readChildThreads,
  writeChildThreadOrder,
} from "./server/child-threads.js";
import { readCardChat, sayToCard } from "./server/cardchat.js";
import { moveProject, readLedger, readReplies, sayToLedger } from "./server/priority.js";
import {
  answerlessAllowBlocked,
  permitQuestions,
  permitResponse,
  permitsToItems,
  questionResponse,
} from "./server/permits.js";
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
    return {
      threads: readChildThreads(dir, items),
      dir: readDir,
      generatedAt: Date.now(),
      orderIsManual: readChildThreadOrder(dir).length > 0,
    };
  });

  server.handle(childThreadsSetOrderRpc, async (input) => {
    try {
      // 並び順は `child_threads_order.json` にだけ書く(既存の child_threads.json は触らない)。
      const order = writeChildThreadOrder(resolveConfirmBoxDir(), input.order);
      return { ok: true, order };
    } catch (error) {
      return { ok: false, order: [], message: `保存できません: ${(error as Error).message}` };
    }
  });

  server.handle(confirmBoxCountRpc, async (_input, ctx) => {
    const { items, sources, generatedAt } = await collect(ctx);
    // 本当に未決 = 決定記録なし(approved でない)かつ選択肢がある項目(通知のみは数えない)
    const open = items.filter((i) => i.state !== "approved" && i.options.length > 0);
    const dir = resolveConfirmBoxDir();
    // バッジは失敗しても0で返す(件数が取れないだけで確認箱そのものは開けるようにする)
    let bugs = 0;
    try {
      bugs = countNewReports(readFeedbackReports().reports);
    } catch {
      bugs = 0;
    }
    let childDone = 0;
    try {
      childDone = readChildThreads(dir, items).filter(
        (t) => t.status === "完了" && t.summaryState !== "read" && t.summaryState !== "approved",
      ).length;
    } catch {
      childDone = 0;
    }
    return {
      open: open.length,
      blocking: open.filter((i) => i.priority === "blocking").length,
      permits: open.filter((i) => i.kind === "permit").length,
      failedSources: sources.filter((src) => !src.ok).length,
      notifications: countUnreadNotifications(items),
      bugs,
      childDone,
      generatedAt,
    };
  });

  server.handle(confirmBoxAckRpc, async (input) => {
    try {
      appendAck(resolveConfirmBoxDir(), input.id, input.action);
      return {
        ok: true,
        message: input.action === "approve" ? "確認しました" : "既読にしました",
      };
    } catch (error) {
      return { ok: false, message: `記録できません: ${(error as Error).message}` };
    }
  });

  server.handle(confirmBoxAckAllRpc, async () => {
    try {
      appendAckAll(resolveConfirmBoxDir());
      return { ok: true, message: "すべて既読にしました" };
    } catch (error) {
      return { ok: false, message: `記録できません: ${(error as Error).message}` };
    }
  });

  server.handle(feedbackReportsListRpc, async () => {
    const { reports, sources } = readFeedbackReports();
    return { reports, sources, generatedAt: Date.now() };
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
      // 質問への回答。**実物の質問**と突き合わせて `updatedInput.answers` を組み立てる
      // (クライアントの言い分をそのまま上流へ流さない)。
      if (input.answers) {
        const built = questionResponse(perm, input.answers);
        if (!built.ok) return { ok: false, message: built.message };
        await ctx.paseo.agents
          .ref(input.agentId)
          .respondToPermission({ requestId: input.requestId, response: built.response });
        return { ok: true, message: "回答を送りました" };
      }

      const response = permitResponse(perm, input.actionId);
      if (answerlessAllowBlocked(perm, response)) {
        // 画面にフォームが出ていない場合(質問が読めなかった等)は、その旨を言う。
        return {
          ok: false,
          message: permitQuestions(perm)
            ? "この承認待ちは質問です。選択肢を選んで回答するか、拒否してください"
            : "この質問は読み取れませんでした。スレで答えるか、拒否してください",
        };
      }
      await ctx.paseo.agents
        .ref(input.agentId)
        .respondToPermission({ requestId: input.requestId, response });
      return { ok: true, message: `応答しました(${response.behavior})` };
    } catch (error) {
      // 上流の失敗は理由が読み取りにくい(例: opencode v2 の複数選択は配列を要求する)。
      // 黙って失敗したように見せず、次に取れる手を示す。
      return {
        ok: false,
        message: `応答できませんでした(${(error as Error).message})。項目が残る場合はスレで答えてください`,
      };
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
      return { messages: readCardChat(resolveConfirmBoxDir(), { id: input.id, key: input.key }) };
    } catch {
      return { messages: [] };
    }
  });

  server.handle(cardChatSayRpc, async (input) => {
    try {
      return sayToCard(resolveConfirmBoxDir(), { id: input.id, key: input.key }, input.text);
    } catch (error) {
      return { ok: false, message: `送れません: ${(error as Error).message}` };
    }
  });

  return () => {};
}
