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
  CHILD_THREAD_REPORT_SOURCE,
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
  isJudgmentItem,
  isNotificationItem,
  priorityListRpc,
  priorityMoveRpc,
  prioritySayRpc,
} from "./shared/contract.js";
import { appendAck } from "./server/ack.js";
import { feedbackReportsListRpc, countNewReports } from "./shared/feedback.js";
import { readFeedbackReports } from "./server/feedback.js";
import type { ConfirmBoxItem, ConfirmBoxSourceStatus } from "./shared/contract.js";
import { appendDecision, readConfirmBox, resolveConfirmBoxDir } from "./server/box.js";
import {
  childThreadsArchiveRpc,
  childThreadsListRpc,
  childThreadsPinRpc,
  childThreadsSetOrderRpc,
} from "./shared/child-threads.js";
import {
  childThreadPinsReadError,
  readChildThreadOrder,
  readChildThreads,
  writeChildThreadOrder,
  writeChildThreadPin,
} from "./server/child-threads.js";
import { cardExists, readCardChat, sayToCard } from "./server/cardchat.js";
import {
  adoptOrphans,
  coordinatorRows,
  dropDeadCoordinators,
  markCoordinators,
  readCoordinatorIds,
} from "./server/coordinator-threads.js";
import { applyThreadAccess, threadAccessById } from "./server/thread-liveness.js";
import type { ThreadAccess } from "./shared/child-threads.js";

import { WORKSPACE_SCAN_LIMIT, decideWorkspaceArchive } from "./server/workspace-membership.js";
import { listLiveWorkspaceIds } from "./server/thread-liveness.js";
import type { WorkspaceArchiveDecision } from "./server/workspace-membership.js";
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

  server.handle(childThreadsListRpc, async (_input, ctx) => {
    const dir = resolveConfirmBoxDir();
    const { items, dir: readDir } = readConfirmBox(dir);
    const rows = readChildThreads(dir, items);
    // 司令塔は登録簿に載らない(登録簿は司令塔が建てた子スレだけ)。起こしデーモンの一覧から
    // 生きている司令塔を先頭の行として足す。取れなければ登録簿の並びのまま出す。
    const ids = readCoordinatorIds();
    let threads = adoptOrphans(markCoordinators(rows, ids));
    try {
      const listed = await ctx.paseo.agents.list();
      // 印付けにはアーカイブ済みのスレも要る(既定の一覧はアーカイブ済みを返さない)。
      // 取れなければ既定の一覧で代用する(閉じたスレは単に「一覧に居ない」=印なしのまま)。
      let forAccess = listed;
      try {
        forAccess = await ctx.paseo.agents.list({
          filter: { includeArchived: true, includeBackground: true },
        });
      } catch {
        forAccess = listed;
      }
      // ファイルの `coordinator_id` は古い id を指し続けることがあるので、閉じた司令塔は落とす。
      const alive = dropDeadCoordinators(
        markCoordinators(rows, ids),
        forAccess.entries.map((e) => e.agent),
      );
      const coordinators = coordinatorRows(
        ids,
        listed.entries.map((e) => e.agent),
        alive,
      );
      // 親の行(司令塔)が出ているなら、その子スレも同じグループへ寄せる。
      threads = adoptOrphans([...coordinators, ...alive]);
      // 押して開けるか(ワークスペースがアーカイブ済みだと会話に着かない)。
      // 一覧は**生きている**ワークスペースしか返さない(アーカイブ済みは含まれない)ので
      // 「在る=開ける、無い=閉じた」で判定する(`listLiveWorkspaceIds` が続きのページも辿る)。
      // 引けなければ空の印を付ける(=行は今まで通り押せる)。
      let access: Map<string, ThreadAccess> = new Map();
      try {
        const live = await listLiveWorkspaceIds(ctx);
        access = threadAccessById(
          forAccess.entries.map((e) => e.agent),
          live.map((workspaceId) => ({ workspaceId })),
        );
      } catch {
        access = new Map();
      }
      threads = applyThreadAccess(threads, access);
    } catch {
      threads = adoptOrphans(markCoordinators(rows, ids));
    }
    return {
      threads,
      dir: readDir,
      generatedAt: Date.now(),
      orderIsManual: readChildThreadOrder(dir).length > 0,
      // ピンのファイルが壊れていても一覧は出すが、黙って「ピン無し」に見せない(画面は console.warn)。
      pinReadError: childThreadPinsReadError(dir),
    };
  });

  /**
   * 行のアーカイブ(agent + そのスレの workspace)。完了→確認箱→アーカイブの自動経路
   * (`child_thread_registry.archive_confirmed`)と同じ2つを閉じる。一覧(登録簿)は書き換えない
   * — サイドバーは Paseo 側のアーカイブと登録簿の同期(`child_thread_registry.sync`)で消える。
   * 実行中のスレは止めないよう断る(会話を途中で殺さない)。ワークスペースは、このスレ以外に
   * 生きている(closed 以外の)スレが1本でも居れば閉じない。数えられないときも閉じない。
   */
  server.handle(childThreadsArchiveRpc, async (input, ctx) => {
    const ref = ctx.paseo.agents.ref(input.agentId);
    try {
      await ref.refresh();
    } catch (error) {
      return { ok: false, message: `スレの状態を取得できません: ${(error as Error).message}` };
    }
    const agent = ref.current();
    if (!agent)
      return { ok: false, message: "スレが見つかりません(既にアーカイブ済みかもしれません)" };
    if (agent.status === "running" || agent.status === "initializing") {
      return {
        ok: false,
        message: "実行中のスレはアーカイブできません(止まってから操作してください)",
      };
    }
    // ワークスペースを閉じる前に、そのワークスペースを共有している他のスレを数える。
    const workspaceId = typeof agent.workspaceId === "string" ? agent.workspaceId : "";
    // 数えられない・上限に達した・ページ情報が欠けているときは**閉じない**(共有ワークスペースを
    // 巻き込む方の事故の方が重い)。そのため安全側の失敗もここで null ではなく unsafe として返す。
    const UNSAFE = (detail: string): WorkspaceArchiveDecision => ({
      safe: false,
      message: `スレをアーカイブしました。ワークスペースの共有状態を確認できないため閉じませんでした(${detail})`,
    });
    const countMembers = async (): Promise<WorkspaceArchiveDecision> => {
      try {
        const listed = await ctx.paseo.agents.list({
          includeBackground: true,
          page: { limit: WORKSPACE_SCAN_LIMIT },
        });
        // `entry.agent.workspaceId` で数える(`entry.project.projectKey` は
        // projectId であって workspaceId ではないため、同じプロジェクトの別
        // workspace と混ざる)。
        const members = listed.entries
          .filter((entry) => entry.agent.workspaceId === workspaceId)
          .map((entry) => ({
            id: entry.agent.id,
            status: entry.agent.status,
            archived: entry.agent.archivedAt != null,
          }));
        // `hasMore` が無い/undefined の経路を「続き無し」と読み替えない(読めないなら安全側)。
        // 一覧が上限ちょうどのときは、続きが無いと言い切れる場合を除き切れている可能性を残す。
        const hasMore =
          listed.pageInfo?.hasMore !== false &&
          (members.length >= WORKSPACE_SCAN_LIMIT || listed.pageInfo?.hasMore === true);
        return decideWorkspaceArchive(input.agentId, members, hasMore);
      } catch (error) {
        return UNSAFE((error as Error).message);
      }
    };
    const decision = workspaceId ? await countMembers() : null;
    try {
      await ref.archive();
    } catch (error) {
      return { ok: false, message: `スレをアーカイブできません: ${(error as Error).message}` };
    }
    if (!workspaceId) {
      return { ok: true, message: "スレをアーカイブしました(ワークスペースは不明のため未処理)" };
    }
    // 判定直後に同じワークスペースへ新しいスレが生まれる競合があるので、閉じる直前に数え直す
    // (窓は消えないが縮む。closed は数えないので、いま閉じた自分が増えても判定は変わらない)。
    const second = await countMembers();
    const blocker = [decision, second].find((d): d is { safe: false; message: string } => {
      return d != null && !d.safe;
    });
    if (blocker) {
      return { ok: true, message: blocker.message };
    }
    try {
      await ctx.paseo.workspaces.archive(ctx.paseo.workspaces.ref(workspaceId));
      return { ok: true, message: "スレとワークスペースをアーカイブしました" };
    } catch (error) {
      // スレは閉じた。ワークスペースは残ったので、そのことを言う(黙って成功にしない)。
      return {
        ok: true,
        message: `スレはアーカイブしましたが、ワークスペースを閉じられません: ${(error as Error).message}`,
      };
    }
  });

  // ピン止めの切り替え。保存先は `child_threads_pins.json` だけで、登録簿(`child_threads.json`)は触らない。
  server.handle(childThreadsPinRpc, async (input) => {
    try {
      const pins = writeChildThreadPin(resolveConfirmBoxDir(), input.agentId, input.pinned);
      return { ok: true, pins };
    } catch (error) {
      return {
        ok: false,
        pins: [],
        message: `ピン止めを保存できません: ${(error as Error).message}`,
      };
    }
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
    // 判断タブと同じ定義(SSOT は `isJudgmentItem`)。通知だけの項目は数えない。
    const open = items.filter((i) => isJudgmentItem(i) && i.state !== "approved");
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
      // 画面の「未確認」と同じ定義(個別 ack が無い)。一覧とバッジの数が食い違わないようにする。
      childDone = readChildThreads(dir, items).filter(
        (t) => t.status === "完了" && !t.summaryAcked,
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

  // 押された項目を**箱に実在するものと突き合わせて**から書く(クライアントの言い分で任意の id を閉じない)。
  // 種類と操作も閉じた列挙で縛る: 通知は既読のみ、子スレの完了まとめは承認のみ、それ以外はこの画面から閉じない
  // (判断待ちの項目をここから既読にすると、誰も選んでいないのに「決まった」扱いになってしまう)。
  function ackReject(item: ConfirmBoxItem | undefined, action: "read" | "approve"): string | null {
    if (!item) return "この項目は確認箱に見つかりません(消えた可能性があります)";
    if (item.source === CHILD_THREAD_REPORT_SOURCE) {
      return action === "approve" ? null : "完了報告は「確認」でのみ閉じられます";
    }
    if (isNotificationItem(item))
      return action === "read" ? null : "通知は既読でしか閉じられません";
    return "判断が必要な項目は一覧から選んで答えてください(この画面では閉じられません)";
  }

  server.handle(confirmBoxAckRpc, async (input, ctx) => {
    try {
      const dir = resolveConfirmBoxDir();
      const reject = ackReject(
        (await collect(ctx)).items.find((i) => i.id === input.id),
        input.action,
      );
      if (reject) return { ok: false, message: reject };
      appendAck(dir, input.id, input.action);
      return {
        ok: true,
        message: input.action === "approve" ? "確認しました" : "既読にしました",
      };
    } catch (error) {
      return { ok: false, message: `記録できません: ${(error as Error).message}` };
    }
  });

  // 「通知」タブの「すべて既読」。`ackall` は判断待ち(選択肢あり)まで既読にしてしまうので使わず、
  // いま通知タブに出ている未読だけを1件ずつ ack する(見えていないものを既読にしない)。
  server.handle(confirmBoxAckAllRpc, async () => {
    try {
      const dir = resolveConfirmBoxDir();
      const { items } = readConfirmBox(dir);
      const unread = items.filter((i) => isNotificationItem(i) && i.state === "new");
      for (const item of unread) appendAck(dir, item.id, "read");
      return { ok: true, message: `通知 ${unread.length}件を既読にしました` };
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
      const dir = resolveConfirmBoxDir();
      return {
        found: cardExists(dir, { id: input.id, key: input.key }),
        messages: readCardChat(dir, { id: input.id, key: input.key }),
      };
    } catch {
      return { found: false, messages: [] };
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
