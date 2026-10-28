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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  CHILD_THREAD_REPORT_SOURCE,
  KIND_LABEL,
  boxSignalRpc,
  compareConfirmBoxItems,
  confirmBoxAckAllRpc,
  confirmBoxAckRpc,
  confirmBoxCountRpc,
  confirmBoxDecideRpc,
  confirmBoxListRpc,
  confirmBoxPermitRpc,
  cardChatListRpc,
  coordinatorTargetRpc,
  cardChatAskRpc,
  cardChatCancelRpc,
  cardChatSayRpc,
  countUrgentUnreadNotifications,
  isNotificationItem,
  priorityArchiveRpc,
  priorityDetailRpc,
  priorityListRpc,
  priorityMoveRpc,
  prioritySayRpc,
  priorityStandingRpc,
  REJECT_CHOICE,
} from "./shared/contract.js";
import { appendAck } from "./server/ack.js";
import {
  readPositionEnableRpc,
  readPositionGetRpc,
  readPositionSetRpc,
} from "./shared/read-position.js";
import {
  getPosition,
  setEnabled as setReadPositionEnabled,
  setPosition,
} from "./server/read-position.js";
import {
  sharedProjectPostRpc,
  sharedProjectReadRpc,
  sharedProjectThreadRpc,
  sharedProjectsListRpc,
} from "./shared/shared-projects.js";
import {
  sharedProjectAiPollRpc,
  sharedProjectAiStartRpc,
  sharedProjectApiRpc,
} from "./shared/shared-projects-api.js";
import { createAiJobs, createPaseoGenerator } from "./server/shared-projects-ai.js";
import {
  callApi,
  fetchThread,
  listProjects,
  markRead,
  postMessage,
} from "./server/shared-projects.js";
import { feedbackReportsListRpc, countOpenReports } from "./shared/feedback.js";
import { readFeedbackReports } from "./server/feedback.js";
import { loadProgressContext } from "./server/feedback-progress.js";
import type { ConfirmBoxItem, ConfirmBoxSourceStatus } from "./shared/contract.js";
import { appendDecision, readConfirmBox, resolveConfirmBoxDir } from "./server/box.js";
import {
  VAULT_KEY_PREFIX,
  answerVaultDecision,
  applyVaultSource,
  bundleNotifications,
  readVaultDecisions,
  vaultSourceEnabled,
} from "./server/vault-decisions.js";
import { isJudgmentCounted } from "./shared/judgment-open.js";
import {
  childThreadsArchiveRpc,
  childThreadsListRpc,
  childThreadsPinRpc,
  childThreadsSetOrderRpc,
} from "./shared/child-threads.js";
import type { ThreadAccess } from "./shared/child-threads.js";
import {
  applyChildThreadOrder,
  childThreadPinsReadError,
  readChildThreadOrder,
  readChildThreadPins,
  readArchivedChildThreadIds,
  readKnownChildThreadIds,
  readChildThreads,
  writeChildThreadOrder,
  writeChildThreadPin,
} from "./server/child-threads.js";
import {
  adoptOrphans,
  coordinatorRows,
  dropDeadCoordinators,
  markCoordinators,
  markOpenableParents,
  readCoordinatorIds,
  readGeneralCoordinatorId,
} from "./server/coordinator-threads.js";
import {
  applyThreadAccess,
  listLiveWorkspaceIds,
  threadAccessById,
} from "./server/thread-liveness.js";
import { listAllAgents } from "./server/agent-pages.js";
import { applyStateDots, stateDotsById } from "./server/agent-state-dots.js";
import {
  dropFinishedClosedRows,
  promoteCoreRows,
  readCoreWindowIds,
  readSidebarHiddenIds,
  standbyForCoreClosed,
} from "./server/closed-rows.js";
import { applyWindowUnread, readWindowId } from "./server/window-unread.js";
import { mergeUnregisteredThreads } from "./server/unregistered-threads.js";
import type { ListedAgentLike } from "./server/unregistered-threads.js";
import { WORKSPACE_SCAN_LIMIT, decideWorkspaceArchive } from "./server/workspace-membership.js";
import type { WorkspaceArchiveDecision } from "./server/workspace-membership.js";
import {
  chooseConceptModel,
  moveConceptNoteRpc,
  notesSidebarRpc,
  openConceptThreadRpc,
} from "./shared/notes.js";
import { readNoteRpc, resolveNoteLinkRpc, saveNoteRpc } from "./shared/note-view.js";
import { saveVaultNote } from "./server/note-edit.js";
import { HISTORY_OFF_MESSAGE, historyEnabled } from "./server/note-history.js";
import { readVaultNote, resolveVaultLink } from "./server/note-view.js";
import type {
  ConceptModelOption,
  MoveConceptNoteOutput,
  OpenConceptThreadOutput,
} from "./shared/notes.js";
import {
  frontmatterToNote,
  parseFrontmatter,
  readNoteHead,
  readSidebarNotes,
  resolveConceptPlan,
  resolveThreadId,
  resolveVaultDir,
  threadIdFromBlockList,
} from "./server/notes.js";
import {
  assertWritableConceptNote,
  canRecordThread,
  conflictRedirect,
  moveConceptNote,
  readHead,
  readThreadKey,
  recordConceptThread,
} from "./server/note-thread.js";
import {
  askFromPane,
  boxRows,
  cancelFromPane,
  cardExists,
  panePending,
  readCardChat,
  sayToCard,
} from "./server/cardchat.js";
import {
  archiveProject,
  buildPriorityDetail,
  countRunning,
  findProject,
  markStanding,
  moveProject,
  readLedger,
  readOpenQuestions,
  readReplies,
  sayToLedger,
  splitArchived,
  type DetailThread,
} from "./server/priority.js";
import type { PriorityProject } from "./shared/contract.js";
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
    const read = readConfirmBox(dir);
    const { dir: readDir } = read;
    let items = read.items;
    const sources = [...read.sources];
    // --- 判断項目の出所は Vault の判断ノートに一本化する(箱側の旧 judgment 行は隠すだけ)
    if (vaultSourceEnabled()) {
      const vault = readVaultDecisions();
      items = applyVaultSource(items, vault.items, vault.error !== null, vault.claimedKeys).items;
      const skippedNote = vault.skipped.length
        ? `(読めず${vault.skipped.length}件: ${vault.skipped
            .slice(0, 3)
            .map((k) => `${k.name}=${k.reason}`)
            .join("、")})`
        : "";
      sources.push({
        id: "pending",
        label: "Vault判断ノート",
        ok: vault.error === null && vault.skipped.length === 0,
        detail:
          vault.error ??
          `${vault.dir}${skippedNote}${vault.waiting ? `(材料待ち${vault.waiting}件は判断タブに出さない)` : ""}`,
        count: vault.items.length,
      });
    }
    items = bundleNotifications(items, isNotificationItem);

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

  // 変更の合図(合図ファイルの mtime。ms)。読めなければ 0=画面は定期取得のまま。
  server.handle(boxSignalRpc, async () => {
    const dir = resolveConfirmBoxDir();
    const mtime = (name: string) => {
      try {
        return fs.statSync(path.join(dir, name)).mtimeMs;
      } catch {
        return 0;
      }
    };
    return { box: mtime("box.signal.jsonl"), child_threads: mtime("child_threads.signal.jsonl") };
  });

  server.handle(childThreadsListRpc, async (_input, ctx) => {
    const dir = resolveConfirmBoxDir();
    const { items, dir: readDir } = readConfirmBox(dir);
    const rows = readChildThreads(dir, items);
    // 司令塔は登録簿に載らない(登録簿は司令塔が建てた子スレだけ)。起こしデーモンの一覧から
    // 生きている司令塔を先頭の行として足す。取れなければ登録簿の並びのまま出す。
    const ids = readCoordinatorIds();
    let threads = adoptOrphans(markCoordinators(rows, ids));
    // 一覧を取れなかったとき、見出しからは開けなくなる(開閉のみ)。黙って挙動を変えず画面へ理由を返す。
    let parentsUnknown = false;
    // 登録簿に載らないスレの取り込みが途中で切れた・取れなかった(一部のスレが出ない)。
    let threadsIncomplete = false;
    try {
      // 印付け(`thread-archived`)に使う一覧。アーカイブ済みを含む1ページだけ見る既存の作りなので、
      // 200件より古いアーカイブ済みスレは印が付かない(既存の残差。出口レビュー round3 指摘1で
      // 「親の判定用とは分ける」判断)。取れなければ空で代用する(印なし=押せるまま)。
      // 既定の一覧を先に1回引く必要はない(取れないときの代わりに使っていたが、空と同じ扱いで足りる。
      // 出口レビュー round1 指摘7a)。
      let forAccess: { entries: { agent: ListedAgentLike }[] } = { entries: [] };
      try {
        const withArchived = await ctx.paseo.agents.list({
          filter: { includeArchived: true, includeBackground: true },
        });
        forAccess = { entries: withArchived.entries };
      } catch {
        // アーカイブ込みを引けない: 印は付かない(閉じたスレは押せるまま)。
      }
      // 開けるかの判定と行の取り込みに使う一覧は**全ページ**辿る。アーカイブ済みは含めない
      // (親の判定は `archivedAt` で落とすので要らない。含めると増え続ける履歴で頁数の上限に当たり、
      // 「後から建てた子司令塔ほど開けない親」という元の症状が戻る。出口レビュー round3 指摘1)。
      let pagedAgents: ListedAgentLike[] | null = null;
      try {
        const paged = await listAllAgents(ctx.paseo.agents, { includeBackground: true });
        pagedAgents = paged.agents;
        // 辿り切れなかった: 後ろのページに居る親は「開けない親」に見えるので、画面に理由を出す。
        // 背景込みを断られた場合(`backgroundDropped`)も背景のスレが親なら同じことが起きるが、
        // 生きている通常のスレは全部見えているので、通知行は出さない(コメントで残す)。
        if (paged.truncated) parentsUnknown = true;
      } catch {
        pagedAgents = null;
        // 1ページ分で代用する。後ろのページに居る親は「開けない親」に見えるので、画面に理由を出す。
        parentsUnknown = true;
      }
      const finalAgents: ListedAgentLike[] = pagedAgents ?? forAccess.entries.map((e) => e.agent);
      // ファイルの `coordinator_id` は古い id を指し続けることがあるので、閉じた司令塔は落とす。
      const alive = dropDeadCoordinators(markCoordinators(rows, ids), finalAgents);
      // 司令塔の行も全ページの一覧から作る(1ページ目だけだと、総司令が2ページ目に落ちたとき
      // 行が出ず、その子が総司令の見出しになって押しても開閉だけになる。既存の欠陥)。
      const coordinators = coordinatorRows(ids, finalAgents, alive);
      // 親の行(司令塔)が出ているなら、その子スレも同じグループへ寄せる。
      threads = adoptOrphans([...coordinators, ...alive]);
      // 登録簿に載っていないスレ(= Paseo の「新しいワークスペース」から人が直接始めたスレ)も行にする
      // (2026-10-24 ユーザー報告)。取れなければ従来どおり登録簿の行だけを出す(行が消えるより出す)。
      // 取り込みは**背景もアーカイブ済みも含めず**引く。背景を含めると、Paseo が内部用途で建てた
      // 背景ワークスペースのスレ(通常の一覧には出ない)まで行として出てしまう。アーカイブ済みを
      // 含めると、増え続ける履歴で頁数の上限に当たり、`truncated` が**平常時にも立つ**
      // (= 縮退通知の狼少年化。出口レビュー round2 指摘1)。`mergeUnregisteredThreads` の
      // `archivedAt` の弾きは保険として残す(ホストの既定が変わっても閉じたスレを行にしない)。
      // ピン止めは保存値を反映する(反映しないと、ピン止めした未登録スレが次の取得で黙って外れる。
      // 出口レビュー round1 指摘3)。
      let unregisteredAgents: ListedAgentLike[] = [];
      try {
        const unregistered = await listAllAgents(ctx.paseo.agents);
        unregisteredAgents = unregistered.agents;
        // 頁数の上限・途中の頁の失敗: 一部のスレが出ない(=元の「出ない」症状と見分けが付かないので通知)。
        if (unregistered.truncated) threadsIncomplete = true;
        if (unregistered.agents.length > 0) {
          threads = mergeUnregisteredThreads(
            threads,
            unregistered.agents,
            ids,
            new Set(readChildThreadPins(dir)),
            // 畳み済みなのに Paseo に残っている1本を「未登録の新しいスレ」として復活させない
            // (2026-10-27 通し検証B 指摘4。畳み直しは登録簿の `retry_listed_archives` が行う)
            readArchivedChildThreadIds(dir),
            // 登録簿に載っているスレは、行に出ていなくても「未登録」ではない(2026-10-27 実測の
            // `12b4eab`。畳み済みの自分+見出しになる常駐の子の組は下の2つの弾きをすり抜けていた)
            readKnownChildThreadIds(dir),
          ).rows;
        }
      } catch {
        // 一覧が引けない: 登録簿の行だけで続ける(通知行で理由を出す)。
        threadsIncomplete = true;
      }
      // 並びは既存行と同じく保存された手動順を最後に適用する(足した未登録スレを後ろに置く)。
      // 足した行のピン止めは `mergeUnregisteredThreads` が状態の帯に出すだけに留め、**並びは動かさない**:
      // 登録簿の行のピン止めはグループ内の先頭へ寄せるが、そのグループの `parentAgentId` は
      // クライアントで欠ける(`buildUpperRows`)。ここで寄せると上の段の先頭へ跳ぶので、規則を揃えない
      // (出口レビュー round1 指摘3。先頭へ寄せたい場合は未登録行にも親 id を渡す設計変更が要る)。
      threads = applyChildThreadOrder(threads, readChildThreadOrder(dir));
      // 押して開けるか。いまの判定は**スレのアーカイブと `closed`**だけを止める
      // (`thread-liveness.ts` のコメント参照)。ワークスペースがアーカイブ済みの場合は
      // ここへ生きている id しか渡していないため `workspace-archived` が付かない
      // (出口レビュー round2 指摘2。既存の欠陥として残差に記録。挙動は変えない)。
      // 引けなければ空の印を付ける(=行は今まで通り押せる)。
      // 入力は1ページ目のアーカイブ込み一覧と**全ページの取り込み一覧**を合わせる(200件より古い
      // 未登録スレも「開ける」と判定する。アーカイブ済みの印は1ページ目の一覧が担う。
      // 出口レビュー round1 指摘4)。
      let access: Map<string, ThreadAccess> = new Map();
      try {
        const live = await listLiveWorkspaceIds(ctx);
        const byId = new Map(
          [...forAccess.entries, ...unregisteredAgents.map((agent) => ({ agent }))].map((e) => [
            String(e.agent.id ?? ""),
            e.agent,
          ]),
        );
        access = threadAccessById(
          [...byId.values()],
          live.ids.map((workspaceId) => ({ workspaceId })),
        );
      } catch {
        access = new Map();
      }
      threads = applyThreadAccess(threads, access);
      // 行の左端の点(橙=承認待ち / 赤=失敗 / 青=実行中 / 緑=新着)。判定は純正 Paseo と同じで、
      // `pendingPermissions` と `attentionReason` が要るため**実時間の一覧からここで決める**
      // (`server/agent-state-dots.ts`)。一覧に居ない行は null(点を出さない=推測しない)。
      // 入力は全ページの一覧と、アーカイブ済みを含む1ページ目の一覧(アーカイブ済みは判定側で落とす)。
      threads = applyStateDots(
        threads,
        stateDotsById([...finalAgents, ...forAccess.entries.map((e) => e.agent)]),
      );
      // 完了箱C(完了報告の窓口)の行だけ、読んでいない報告があるあいだ「未読あり」にする
      // (2026-10-26 ユーザー依頼。橙は判断待ち専用なので緑=新着を使う)。既読は Paseo の
      // attention が消えた時点で判る(`server/window-unread.ts`)。点を付けた後に重ねる。
      threads = applyWindowUnread(
        threads,
        [...finalAgents, ...forAccess.entries.map((e) => e.agent)],
        readWindowId(),
      );
      // 子を持つ親(=グループ見出し)のうち、一覧に生きていて開けるものを「開ける親」にする。
      // 子司令塔はデーモンの `coordinator_id` に載らないため、これが無いと見出しを押しても開けない
      // (2026-10-24 ユーザー報告)。行は増やさない(親の行は見出しが既に担う)。
      // 親の判定は**全ページ**の一覧で行う(1ページ目だけだと、後から建てた子司令塔ほど
      // 「開けない親」に落ちて見出しが開閉だけになる。出口レビュー round2 指摘1)。
      threads = markOpenableParents(threads, finalAgents, access);
      // 閉じた中核スレは「終了」でなく「待機中」、終わった閉じ行と非表示 id は外す(2026-10-28)。
      threads = dropFinishedClosedRows(
        promoteCoreRows(standbyForCoreClosed(threads, readCoreWindowIds()), readCoreWindowIds()),
        readCoreWindowIds(),
        readSidebarHiddenIds(),
      );
    } catch {
      threads = adoptOrphans(markCoordinators(rows, ids));
      parentsUnknown = true;
      threadsIncomplete = true;
    }
    return {
      threads,
      dir: readDir,
      generatedAt: Date.now(),
      orderIsManual: readChildThreadOrder(dir).length > 0,
      // ピンのファイルが壊れていても一覧は出すが、黙って「ピン無し」に見せない(画面は console.warn)。
      pinReadError: childThreadPinsReadError(dir),
      parentsUnknown,
      threadsIncomplete,
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
    // 司令塔自身は畳まない(2026-10-23 24:22 に paseo_ui の司令塔 6f957aa9 がこの経路でアーカイブされ、
    // その領域の起こし通知が「司令塔が見つからない」で全滅した)。判定材料は起こしデーモンが持つ実行時の
    // 正本(`domains/<領域>/coordinator_id`)で、サイドバーの行と同じ出所。**refresh より前**に断る
    // (refresh はアーカイブ状態を解いてしまうため、断るだけの操作で状態を動かさない)。
    // 本スレッドの作業ブランチは `00e3f5082` から切っており、この行は後から本番ブランチ
    // `topos-customizations` にだけ入った(マージ時に本番の防御を外さないため戻す。2026-10-24)。
    if (readCoordinatorIds().includes(input.agentId)) {
      return {
        ok: false,
        message: "司令塔のスレはアーカイブできません(畳むとその領域の起こし通知が止まります)",
      };
    }
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
    // 数え方の SSOT は `countJudgmentCounted`。判断窓口の counts.open(N)と同じ対象に揃えるため、
    // Vault 判断ノート由来の項目と permit のうち state が new だけを数え、材料待ち・承認済み・既読と
    // ノートを持たない古い箱の判断行(答え先が無い行)は数えない。通知だけの項目も数えない。
    const open = items.filter(isJudgmentCounted);
    // N の対象(Vault ノート)を読めなかった/読まない設定のときは 0 件を「判断待ちなし」と誤読させない。
    // 出所が failedSources に入っていれば `collect` が Vault を読めなかった(`applyVaultSource(..., true)`)。
    const openKnown = vaultSourceEnabled() && sources.every((src) => src.ok);
    // バッジは失敗しても0で返す(件数が取れないだけで確認箱そのものは開けるようにする)
    let bugs = 0;
    try {
      // バッジ=**まだ終わっていない**報告(2026-10-26 ユーザー判断。以前は status==="new" だけ数えていた)
      bugs = countOpenReports(readFeedbackReports().reports);
    } catch {
      bugs = 0;
    }
    return {
      open: open.length,
      openKnown,
      blocking: open.filter((i) => i.priority === "blocking").length,
      permits: open.filter((i) => i.kind === "permit").length,
      failedSources: sources.filter((src) => !src.ok).length,
      notifications: countUrgentUnreadNotifications(items),
      bugs,
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
      const target = (await collect(ctx)).items.find((i) => i.id === input.id);
      for (const id of target?.memberIds ?? [input.id]) appendAck(dir, id, input.action);
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
    const ctx = loadProgressContext(readConfirmBox(resolveConfirmBoxDir()).items);
    const { reports, sources } = readFeedbackReports(undefined, undefined, ctx);
    return { reports, sources, generatedAt: Date.now() };
  });

  server.handle(confirmBoxDecideRpc, async (input) => {
    if (!input.key) return { ok: false, message: "key が空です" };
    const reject = input.chosen === REJECT_CHOICE;
    if (reject && !input.reason.trim()) {
      return { ok: false, message: "却下にはコメントが必要です(理由を書いてください)" };
    }
    if (reject && !input.key.startsWith(VAULT_KEY_PREFIX)) {
      return { ok: false, message: "却下できるのは Vault の判断ノートの項目だけです" };
    }
    try {
      // Vault の判断ノートへの回答は、まずノート(正本)を answered にする。失敗したら台帳にも書かない。
      let noteNote = "";
      if (input.key.startsWith(VAULT_KEY_PREFIX)) {
        const noteItem = readVaultDecisions().items.find((i) => i.key === input.key);
        const option = noteItem?.options.find((o) => o.id === input.chosen);
        if (input.chosen !== null && !reject && !option) {
          return { ok: false, message: `選択肢 ${input.chosen} はこの判断にありません` };
        }
        const label = option?.label ?? null;
        const file = answerVaultDecision({
          key: input.key,
          chosenId: input.chosen,
          chosenLabel: label,
          reason: input.reason,
          reject,
        });
        noteNote = `・ノート更新 ${file.split("/").pop()}`;
      }
      try {
        appendDecision(resolveConfirmBoxDir(), {
          key: input.key,
          chosen: input.chosen,
          // 却下は「推奨と別の選択肢を選んだ」ではなく問いの取り下げ。推奨の的中集計(matched)を汚さない
          recommended: reject ? null : input.recommended,
          depth: input.depth,
          reason: input.reason,
          source: input.source,
        });
      } catch (ledgerError) {
        // ノート(正本)は更新済み。台帳だけ失敗しても再回答は「上書きしません」で詰むので、成功として警告を添える。
        if (!noteNote) throw ledgerError;
        return {
          ok: true,
          message: `ノートは更新しました(${input.key})が台帳への記録に失敗: ${(ledgerError as Error).message}${noteNote}`,
        };
      }
      return {
        ok: true,
        message: reject
          ? `却下しました(${input.key})${noteNote}`
          : `記録しました(${input.key} → ${input.chosen ?? "選択なし"})${noteNote}`,
      };
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
    const { projects: all, updatedTs } = readLedger(dir);
    const { visible, archived, standing } = splitArchived(all);
    // 動いている子スレの件数は一覧を作るたびに数える(保存しない=古い数を出さない)
    let threads: DetailThread[] = [];
    try {
      threads = readChildThreads(dir).map((t) => ({
        agentId: t.agentId,
        title: t.title,
        status: t.status,
        machineState: t.machineState,
      }));
    } catch {
      threads = []; // 数えられない=0件であってもアーカイブは止めない(確認を出さないだけ)
    }
    const withRunning = (rows: PriorityProject[]): PriorityProject[] =>
      rows.map((p) => ({ ...p, running: countRunning(p, threads) }));
    return {
      projects: withRunning(visible),
      archived: withRunning(archived),
      standing: withRunning(standing),
      replies: readReplies(dir),
      updatedTs,
    };
  });

  server.handle(priorityArchiveRpc, async (input) => {
    try {
      return archiveProject(resolveConfirmBoxDir(), input.id, input.archived);
    } catch (error) {
      return { ok: false, message: `アーカイブできません: ${(error as Error).message}` };
    }
  });

  server.handle(priorityStandingRpc, async (input) => {
    try {
      return markStanding(resolveConfirmBoxDir(), input.id, input.standing);
    } catch (error) {
      return { ok: false, message: `移せません: ${(error as Error).message}` };
    }
  });

  server.handle(priorityDetailRpc, async (input) => {
    const dir = resolveConfirmBoxDir();
    const project = findProject(dir, input.id);
    if (!project) return null;
    // 登録簿が読めなくても中身(説明・未決の判断)は出す。子スレ欄だけ空になる
    let threads: { agentId: string; title: string; status: string; machineState: string | null }[] =
      [];
    try {
      threads = readChildThreads(dir).map((t) => ({
        agentId: t.agentId,
        title: t.title,
        status: t.status,
        machineState: t.machineState,
      }));
    } catch {
      threads = [];
    }
    return buildPriorityDetail(project, threads, readOpenQuestions(dir, project.name));
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

  // 読んだ位置(端末をまたいで同じ位置で開き直す)。取得失敗は「記録しない」側に倒し、画面は止めない。
  server.handle(readPositionGetRpc, async (input) => {
    try {
      return getPosition(resolveConfirmBoxDir(), input.agentId, input.title);
    } catch {
      return { enabled: false, seq: null, epoch: null, updatedAt: null };
    }
  });
  server.handle(readPositionSetRpc, async (input) => {
    try {
      return setPosition(
        resolveConfirmBoxDir(),
        input.agentId,
        input.title,
        input.seq,
        input.epoch,
      );
    } catch (error) {
      return {
        ok: false,
        seq: null,
        message: `読んだ位置を保存できません: ${(error as Error).message}`,
      };
    }
  });
  server.handle(readPositionEnableRpc, async (input) => {
    try {
      setReadPositionEnabled(resolveConfirmBoxDir(), input.agentId, input.enabled);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `切り替えを保存できません: ${(error as Error).message}` };
    }
  });

  // 共有プロジェクト(参加中のものだけ。Topos の範囲つきトークンで取る。鍵・設定が無ければ unconfigured)。
  server.handle(sharedProjectsListRpc, async () => {
    const r = await listProjects();
    return r.ok
      ? { status: "ok" as const, projects: r.projects }
      : { status: r.status, message: r.message, projects: [] };
  });
  server.handle(sharedProjectThreadRpc, async (input) => {
    const r = await fetchThread(input.id);
    return r.ok
      ? {
          status: "ok" as const,
          messages: r.messages,
          latestSeq: r.latestSeq,
          shownMaxSeq: r.shownMaxSeq,
          unread: r.unread,
        }
      : {
          status: r.status,
          message: r.message,
          messages: [],
          latestSeq: 0,
          shownMaxSeq: 0,
          unread: 0,
        };
  });
  server.handle(sharedProjectPostRpc, async (input) => postMessage(input.id, input.text));
  server.handle(sharedProjectReadRpc, async (input) => markRead(input.id, input.seq));
  // フル機能: 許可リスト(API_OPS)の操作だけを Topos へ中継する(任意パスは拒否)。
  server.handle(sharedProjectApiRpc, async (input) => callApi(input));
  // AI生成はPaseo側(Toposは projects_full 鍵ではLLMを呼ばない)。start=prepareまで行いジョブIDを即返す /
  // poll=結果を待つ。生成はこのプロセス内で背景実行(RPCの30秒上限より長いため)。
  let paseoForAi: PluginHandlerContext["paseo"] | null = null;
  const aiJobs = createAiJobs({
    call: (input) => callApi(input, {}, { internal: true }),
    generate: createPaseoGenerator(() => {
      if (!paseoForAi) throw new Error("paseo_unavailable");
      return paseoForAi;
    }),
    // ticket・本文・プロンプト・鍵は渡さない(ジョブ短縮ID・種類・段階・理由コードだけ)
    log: (line) => console.warn(`[topos-confirm-box] ${line}`),
  });
  server.handle(sharedProjectAiStartRpc, async (input, ctx) => {
    paseoForAi = ctx.paseo;
    return aiJobs.start(input);
  });
  server.handle(sharedProjectAiPollRpc, async (input) => aiJobs.poll(input.jobId));

  server.handle(coordinatorTargetRpc, async () => ({
    agentId: readGeneralCoordinatorId(),
    hubIds: readCoordinatorIds(),
  }));

  server.handle(cardChatListRpc, async (input) => {
    try {
      const dir = resolveConfirmBoxDir();
      const target = { id: input.id, key: input.key };
      const rows = boxRows(dir);
      return {
        found: cardExists(dir, target, rows),
        messages: readCardChat(dir, target, { topic: input.topic }, rows),
        ...(input.topic ? { pending: panePending(dir, target, Date.now(), rows) } : {}),
      };
    } catch {
      return { found: false, messages: [] };
    }
  });

  /** 生存リストに印を付ける(`live: false` = デーモンの一覧を読み切れていない)。 */
  function markLive(ids: Set<string> | undefined, live: boolean): LiveThreadIndex | undefined {
    return ids ? Object.assign(ids, { live }) : ids;
  }

  /**
   * タップ先にしてよい実在のスレID。2つの出所を**和**にする:
   * (1) 子スレ一覧 `child_threads.json`(サイドバーの既存行)
   * (2) デーモンの**アーカイブされていない**全スレ(`ctx.paseo.agents.list()`。ページ上限200の先も辿る)
   * (2) が要るのは、構想ノートを押して作った深掘りスレが (1) にはまだ載らないため
   * (載らないまま絞ると、毎回「未作成」に見えて2本目を作ってしまう。出口レビュー round2 指摘4)。
   * デーモンが引けないときは (1) だけで続ける。両方引けなければ undefined(=UUID をそのまま使う)。
   */
  async function knownAgentIdsFor(paseo?: PaseoApi): Promise<LiveThreadIndex | undefined> {
    let known: Set<string> | undefined;
    try {
      known = new Set(readChildThreads(resolveConfirmBoxDir()).map((t) => t.agentId));
    } catch {
      known = undefined;
    }
    if (!paseo) return markLive(known, false);
    try {
      const ids = known ?? new Set<string>();
      // 既定ページは200件。セッションが増えると今作ったスレが2ページ目に落ち、存在しないと
      // 誤判定される(→重複作成)ので全ページ辿る。読み切れなければ例外にして (1) へ縮退する。
      let cursor: string | undefined;
      for (let page = 0; page < LIVE_THREAD_PAGES_MAX; page += 1) {
        const live = await paseo.agents.list({
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const entry of live.entries) if (!entry.agent.archivedAt) ids.add(entry.agent.id);
        cursor = live.pageInfo?.nextCursor ?? undefined;
        if (!cursor) return markLive(ids, true);
      }
      throw new Error("一覧が長すぎます");
    } catch {
      // デーモンの一覧が引けなかった。呼び出し側が「生存リストは不完全」と扱えるよう印を付ける。
      return markLive(known, false);
    }
  }

  server.handle(notesSidebarRpc, async (_input, ctx) => {
    const generatedAt = Date.now();
    try {
      // 存在するスレだけをタップ先にする(走査のたびに1回だけ読む)。
      const knownAgentIds = await knownAgentIdsFor(ctx.paseo);
      // 構想の新置き場(`<Vault>/Paseo/構想/{検討中,あとで}`)が在ればそこも読む(無ければ旧置き場だけ)。
      // 置き場のパスは走査先と同じ Vault から決める(明示設定のときも揃う)。
      const vaultDir = resolveVaultDir();
      const r = readSidebarNotes({
        knownAgentIds,
        vaultDir,
        concept: resolveConceptPlan(vaultDir),
      });
      return { ...r, generatedAt };
    } catch (error) {
      // 走査先の設定誤り(バックアップ指定など)は握りつぶさず、空の一覧と理由を返す。
      return {
        notes: [],
        roots: [],
        generatedAt,
        truncated: false,
        scanned: 0,
        error: `ノートを読めません: ${(error as Error).message}`.slice(0, 200),
      };
    }
  });

  // ------------------------------------------------- 構想の「あとで」(2026-10-24 ユーザー指示)

  server.handle(moveConceptNoteRpc, async (input): Promise<MoveConceptNoteOutput> => {
    try {
      const r = await moveConceptNote(path.resolve(input.path), input.to, {
        vaultDir: resolveVaultDir(),
      });
      const label = input.to === "later" ? "あとで" : "検討中";
      return {
        ok: true,
        path: r.notePath,
        message: r.result === "already" ? `既に${label}にあります` : `${label}に移しました`,
      };
    } catch (error) {
      return { ok: false, path: null, message: `移せません: ${(error as Error).message}` };
    }
  });

  // ------------------------------------------------- 構想ノート → 深掘りスレ(2026-10-23 決定)

  /**
   * 記録に失敗した(`record: "pending"`)スレID。ノートのパス → ID。
   * 記録できないまま次に押されるとノートには何も残っていないので**2本目**を作ってしまう。
   * この表があれば、次の押下では作成せず**記録だけ再試行**する(出口レビュー round1 指摘1)。
   * プロセス内の表なのでデーモン再起動で失われる(その場合の重複は残る)。
   */
  const unrecordedThreads = new Map<string, string>();
  /**
   * このプラグインが**作った**スレID(ノートのパス → ID と時刻)。記録できている場合も残す。
   * 記録直後は `agents.list` にまだ載っていないことがあり、その間に押すと
   * 「thread: の行を消すと新しく作ります」と案内して2本目を誘発する(round3 指摘4)。
   */
  const createdHere = new Map<string, { threadId: string; at: number }>();
  /** `createdHere` を生きているとみなす時間(一覧への反映待ちとして十分な長さ)。 */
  const CREATED_HERE_TTL_MS = 10 * 60_000;

  function rememberCreated(key: string, threadId: string): void {
    createdHere.delete(key);
    createdHere.set(key, { threadId, at: Date.now() });
    while (createdHere.size > UNRECORDED_MAX) {
      const oldest = createdHere.keys().next().value;
      if (oldest === undefined) break;
      createdHere.delete(oldest);
    }
  }
  const UNRECORDED_MAX = 200;

  function rememberUnrecorded(key: string, threadId: string): void {
    unrecordedThreads.delete(key);
    unrecordedThreads.set(key, threadId);
    while (unrecordedThreads.size > UNRECORDED_MAX) {
      const oldest = unrecordedThreads.keys().next().value;
      if (oldest === undefined) break;
      unrecordedThreads.delete(oldest);
    }
  }

  /** ノートへ記録し、RPC の形に揃える(記録に失敗してもスレは開けるので `ok: true`)。 */
  async function recordThread(
    resolved: string,
    threadId: string,
    vaultDir: string,
    created: boolean,
  ): Promise<OpenConceptThreadOutput> {
    try {
      const { result } = await recordConceptThread(resolved, threadId, { vaultDir });
      // 別の書き手が先に別IDを書いていた(`conflict`)。作ってしまった方(孤児)は開かず、
      // **ノートが指す方**を開く。押下の入口(再試行)と作成直後の両方に効かせるため、
      // 判定はここ1か所に置く(出口レビュー round3 指摘2)。
      const bound = result === "conflict" ? conflictRedirect(readHeadOf(resolved), threadId) : null;
      if (bound) {
        return {
          ok: true,
          threadId: bound,
          created: false,
          record: "already",
          recordError: null,
          message: "",
        };
      }
      return { ok: true, threadId, created, record: result, recordError: null, message: "" };
    } catch (error) {
      return {
        ok: true,
        threadId,
        created,
        record: "pending",
        recordError: (error as Error).message,
        message: "",
      };
    }
  }

  /** 記録後の読み直し用(読めなければ空 = ノートのIDを優先しない)。 */
  function readHeadOf(file: string): string {
    try {
      return readHead(file);
    } catch {
      return "";
    }
  }

  /**
   * 作成中のスレ(ノートのパス → Promise)。60秒で諦めた後も**作成自体は続いている**ので、
   * 次の押下では作り直さずにこれを待つ(round2 指摘2: 諦めた直後に押されると2本目ができ、
   * さらに孤児の方を開いてしまう)。完了したら表から消す。
   */
  const pendingCreates = new Map<string, Promise<string>>();
  /** 作成を始めた時刻(±の待ちに上限を置き、決着しない作成でノートを詰まらせない。round3 指摘3)。 */
  const createStarted = new Map<string, number>();
  /** 諦めた時刻(これ以降に完了したスレは、ノートへ記録できていない)。 */
  const createTimeouts = new Map<string, number>();
  /** 作成が決着しないまま待つのをやめる上限。過ぎたら「作り直すか」をユーザーに任せる。 */
  const CREATE_PENDING_MAX_MS = 10 * 60_000;
  /** 作ったスレのハンドル(ノートのパス → handle)。最初の発話の成否を短く見るためだけに持つ。 */
  const createdHandles = new Map<string, PaseoAgentHandle>();
  /** 最初の発話が通ったかを見る待ち時間。長く待つとタップの反応が鈍るので短く切る。 */
  const START_PROBE_MS = 2_000;

  /**
   * スレを1本作る。**60秒で諦める**(デーモンが応答しないまま押下が固まり、単一飛行の表に
   * 残り続けるのを防ぐ)。諦めた後も作成は続くので、その Promise は `pendingCreates` に残し、
   * 次の押下では**作り直さずに待つ**。
   */
  async function createConceptThread(
    ctx: PluginHandlerContext,
    key: string,
    resolved: string,
    note: ReturnType<typeof frontmatterToNote>,
  ): Promise<string> {
    const existing = pendingCreates.get(key);
    if (existing) {
      // 作成中(前回60秒で諦めた分かもしれない)。待って、まだ駄目なら「作成中」と返す。
      const id = await Promise.race([existing, sleepResolve(PENDING_RETRY_WAIT_MS, "")]);
      if (id) return id;
      const startedAt = createStarted.get(key) ?? Date.now();
      if (Date.now() - startedAt > CREATE_PENDING_MAX_MS) {
        // 決着しない作成はここで諦めて表から外す。**この押下では作らない**が、押し直せば
        // 作り直せる(2本目になりうるので、黙って作らず一度は理由を出す。round3 指摘3)。
        if (pendingCreates.get(key) === existing) pendingCreates.delete(key);
        createStarted.delete(key);
        const minutes = Math.round((Date.now() - startedAt) / 60_000);
        throw new Error(
          `前回の作成がまだ終わっていません(開始から約${minutes}分)。` +
            "もう一度押すと作り直します(2本目になる可能性があります)",
        );
      }
      throw new Error("いま作っています(完了すると次から開けます)");
    }
    // モデルは**デーモンが申告する一覧から選ぶ**。固定IDを書くと、そのIDが受付外の
    // プロバイダに当たったとき「スレはできるが最初の発話が HTTP 400 で失敗」=押しても
    // 開かないように見える失敗になる(2026-10-23 実機)。選べないなら**作らない**。
    const model = await chooseConceptModel((p) => conceptModelCatalog(ctx, p));
    // 作った直後の最初の発話が失敗していないかを見るため、ハンドルを控えておく
    // (成功・失敗は `createAndRecord` が確認して表から消す)。
    createdHandles.delete(key);
    const creating = ctx.paseo.agents.create({
      // 既定はTopos既定(DeepSeek V4.1 flash low)。画面の「最後に選んだモデル」は
      // 端末側にあり插件から読めないため、読めるようになるまでは明示する。
      // モードも明示する: `default`(Always Ask)だと最初のターンで Vault ノート(cwd 外)を
      // 読む所で承認待ちに止まり、ユーザーには「開かない」に見える。
      config: {
        provider: model.providerModel,
        ...(model.thinkingOptionId ? { thinkingOptionId: model.thinkingOptionId } : {}),
        modeId: "bypassPermissions",
      },
      cwd: conceptThreadCwd(),
      title: conceptThreadTitle(note?.title || path.basename(resolved, ".md")),
      prompt: conceptThreadPrompt(note?.conclusion ?? "", resolved),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`応答がありません(${CREATE_TIMEOUT_MS / 1000}秒)`)),
        CREATE_TIMEOUT_MS,
      );
    });
    const id = creating.then((handle) => {
      createdHandles.set(key, handle);
      return handle.id;
    });
    pendingCreates.set(key, id);
    createStarted.set(key, Date.now());
    void id
      .then((threadId) => {
        // 諦めた後に完成した: ノートへは書けていないので、次に押したら記録だけさせる。
        if (createTimeouts.has(key)) rememberUnrecorded(key, threadId);
        return undefined;
      })
      // 失敗・タイムアウトは呼び出し側が扱う(ここでは片付けだけ)。
      .catch(() => undefined)
      .finally(() => {
        if (pendingCreates.get(key) === id) pendingCreates.delete(key);
        createStarted.delete(key);
        createTimeouts.delete(key);
      });
    try {
      const threadId = await Promise.race([id, timeout]);
      return threadId;
    } catch (error) {
      // 諦めても `pendingCreates` には残す。次の押下は作り直さずに待つ。
      createTimeouts.set(key, Date.now());
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `ms` 後に `value` を返す(待ち合わせ用)。 */
  function sleepResolve(ms: number, value: string): Promise<string> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  /** モデル一覧を引く上限。プロバイダのコールドスタートでも一覧自体は少し待てば返る。 */
  const MODEL_CATALOG_TIMEOUT_MS = 20_000;

  /**
   * デーモンが申告するモデル一覧(選定に要る分だけ)。引けなければ null
   * (=このプロバイダは使わない。固定値で補填しない: 受付外のIDで作ると
   * スレだけ増えて最初の発話が失敗する)。
   */
  async function conceptModelCatalog(
    ctx: PluginHandlerContext,
    provider: string,
  ): Promise<ConceptModelOption[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MODEL_CATALOG_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        ctx.paseo.providers.listModels(provider, { cwd: conceptThreadCwd() }).catch(() => null),
        timeout,
      ]);
      if (!result || result.error || !result.models) return null;
      return result.models.map((m) => ({
        provider,
        id: m.id,
        label: m.label,
        isSelectable: m.isSelectable,
        thinkingOptions: m.thinkingOptions?.map((o) => ({ id: o.id })),
      }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 対象ノート(解決済みパス・Vault の根・RPC が受け取ったパス)。 */
  interface NoteContext {
    key: string;
    resolved: string;
    vaultDir: string;
  }

  /** 失敗の戻り値。 */
  function failOutput(message: string): OpenConceptThreadOutput {
    return {
      ok: false,
      threadId: null,
      created: false,
      record: "skipped",
      recordError: null,
      message,
    };
  }

  /**
   * 押下時に読む先頭。一覧と同じ `readNoteHead`(上限 `HEAD_BYTES` は `notes.ts` が SSOT。
   * round3 指摘7)。読めなければ null。
   */
  function prepareHead(ctx: NoteContext): string | null {
    return readNoteHead(ctx.resolved) || null;
  }

  /** 直前にここで作ったスレなら、一覧に載っていなくても存在する(round3 指摘4)。 */
  function recentlyCreated(key: string, threadId: string): boolean {
    const mine = createdHere.get(key);
    if (!mine || mine.threadId !== threadId) return false;
    if (Date.now() - mine.at <= CREATED_HERE_TTL_MS) return true;
    createdHere.delete(key);
    return false;
  }

  /**
   * (0) 記録だけ失敗した前回のスレがあれば、作り直さずに記録をやり直す。何も無ければ null。
   * ノートに別のIDが書かれていたら(手で直した)、その判断を優先して控えを捨てる。
   */
  async function retryUnrecorded(
    ctx: NoteContext,
    head: string,
  ): Promise<OpenConceptThreadOutput | null> {
    const { key, resolved, vaultDir } = ctx;
    const retry = unrecordedThreads.get(key);
    if (!retry) return null;
    const boundNow = readThreadKey(head);
    if (boundNow && boundNow !== retry) {
      unrecordedThreads.delete(key);
      return null;
    }
    // ノートに別のスレが既に書かれていた場合(作ったが記録できなかった方=孤児を開かない)は
    // `recordThread` がノートのIDへ差し替えて返す。
    const recorded = await recordThread(resolved, retry, vaultDir, false);
    if (recorded.record !== "pending") unrecordedThreads.delete(key);
    return recorded;
  }

  /**
   * 構想ノートを押したときの処理。**1ノートにつきスレは1本**が不変条件:
   * 0. 前回このノート用に作って記録できなかったスレがあれば、**作らずに記録だけやり直す**。
   * 1. ノートに書かれた候補のうち、生きているスレがあれば**作らずに開く**(`already`)。
   * 2. `thread:` にIDがあるのに生きているスレが無ければ、**作らない**(作っても記録が
   *    `conflict` になり、押すたびに2本目が増えるため)。理由と解き方を返してユーザーに任せる。
   * 3. それ以外は1本作り、`thread:` へ記録する(記録の実装は `server/note-thread.ts` に隔離)。
   */
  async function openConceptThread(
    key: string,
    ctx: PluginHandlerContext,
  ): Promise<OpenConceptThreadOutput> {
    const fail = failOutput;
    const openExisting = (threadId: string): OpenConceptThreadOutput => ({
      ok: true,
      threadId,
      created: false,
      record: "already",
      recordError: null,
      message: "",
    });
    let resolved: string;
    let vaultDir: string;
    try {
      vaultDir = resolveVaultDir();
      // スレを作る**前**に、書いてよいノートかを確かめる(作ってから書けないと分かるのを避ける)。
      resolved = assertWritableConceptNote(key, vaultDir);
    } catch (error) {
      return fail((error as Error).message);
    }

    const ctxOf: NoteContext = { resolved, vaultDir, key };
    const head = prepareHead(ctxOf);
    if (!head) return fail(`ノートを読めません: ${resolved}`);

    const retried = await retryUnrecorded(ctxOf, head);
    if (retried) return retried;

    const fm = parseFrontmatter(head);
    const note = fm ? frontmatterToNote(fm, path.basename(resolved, ".md")) : null;
    const live = await knownAgentIdsFor(ctx.paseo);
    const candidates = [...(note?.threadCandidates ?? []), ...threadIdFromBlockList(head)];

    const existing = resolveThreadId(candidates, live);
    if (existing) return openExisting(existing);

    const bound = readThreadKey(head);
    if (bound && recentlyCreated(key, bound)) return openExisting(bound);
    if (bound && live?.live) {
      // 生存リストまで読めている。このIDのスレは本当に無い(アーカイブ済みなど)。
      return fail(
        `ノートの thread: が指すスレ(${bound})が見つかりません(アーカイブ済みかもしれません)。` +
          "そのスレでよければノートの thread: の行を消すと新しく作ります",
      );
    }
    // 一覧が引けなかっただけかもしれない。開くだけなら害が無いので通す(記録もしない)。
    if (bound) return openExisting(bound);

    if (!live?.live) {
      // 生存一覧を読み切れていない。UUID らしい候補(`thread_id:` / `threads:` だけのノート)が
      // あれば、生きている可能性があるので**作らずに開く**(round2 指摘3: 作ると2本目になる)。
      const uuid = candidates.find((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id));
      if (uuid) return openExisting(uuid);
    }

    if (!canRecordThread(head)) {
      // `thread:` が空で直後がリスト等の形は、1行だけ埋めると YAML が壊れる(記録は必ず
      // conflict)。ここで止めないと**押すたびにスレが1本増える**(round3 指摘1)。
      return fail(
        `ノートの frontmatter に thread: を書ける形がありません(${resolved})。` +
          "frontmatter を整えるとスレを作れます",
      );
    }

    return createAndRecord(ctxOf, ctx, note);
  }

  /** 作成 → 控え → 記録。作成に失敗したときの後始末(完成済みの控えの提示)も含む。 */
  async function createAndRecord(
    ctxOf: NoteContext,
    ctx: PluginHandlerContext,
    note: ReturnType<typeof frontmatterToNote>,
  ): Promise<OpenConceptThreadOutput> {
    const { key, resolved, vaultDir } = ctxOf;
    let threadId: string;
    try {
      threadId = await createConceptThread(ctx, key, resolved, note);
    } catch (error) {
      // 以前の作成が後から完成していた(`rememberUnrecorded` が控えた)なら、それを記録する。
      const late = unrecordedThreads.get(key);
      if (late) return recordThread(resolved, late, vaultDir, true);
      // 待ち切っただけで、作成自体はまだ続いていることがある(round2 指摘2c)。
      // その場合もう一度押すと**作り直さずに**待つ(または完成したIDを記録する)。
      return failOutput(
        `スレを作れません: ${(error as Error).message}` +
          "(作成が続いている場合があります。少し待ってからもう一度押してください。2本目は作りません)",
      );
    }
    // 記録に失敗しても、次の押下で作り直さず記録だけ再試行できるよう控える。
    // 記録できた場合も控える(直後の押下で「見つかりません」と誤報しないため)。
    rememberUnrecorded(key, threadId);
    rememberCreated(key, threadId);
    const recorded = await recordThread(resolved, threadId, vaultDir, true);
    if (recorded.record !== "pending") unrecordedThreads.delete(key);
    return { ...recorded, startError: await probeThreadStart(key) };
  }

  /**
   * 作ったスレの**最初の発話**が失敗していないか、ごく短く見る。作るだけでは
   * 「スレはできたが中身がエラー1行」=押しても開かないように見える失敗が残る
   * (2026-10-23 実機: 受付外モデルで HTTP 400)。見切ったら null(未確認)を返す。
   */
  async function probeThreadStart(key: string): Promise<string | null> {
    const handle = createdHandles.get(key);
    if (!handle) return null;
    try {
      const started = await handle.waitForFinish(START_PROBE_MS).catch((error: unknown) => ({
        status: "error" as const,
        error: (error as Error).message,
      }));
      if (started.status === "timeout") return null;
      if (started.status === "idle") return null;
      if (started.status === "permission") {
        return "スレは作りましたが、最初のターンが承認待ちで止まりました(スレを開いて承認してください)";
      }
      return started.error ?? handle.current()?.lastError ?? "最初のターンが失敗しました";
    } finally {
      if (createdHandles.get(key) === handle) createdHandles.delete(key);
    }
  }

  // ノートの閲覧(読むだけ)。live Vault の中のノートだけを返す。
  server.handle(readNoteRpc, async (input) => {
    const note = readVaultNote(resolveVaultDir(), input.path);
    // 変更履歴(Topos のローカル git)が未設定なら編集させない(履歴なしの上書きはしない)。
    if (!note.editable || historyEnabled()) return note;
    return { ...note, editable: false, editBlock: HISTORY_OFF_MESSAGE, raw: "", version: "" };
  });
  // 既存ノートの編集(競合検知・履歴つき。新規作成・削除・名前変更はしない)。
  server.handle(saveNoteRpc, async (input) =>
    saveVaultNote(resolveVaultDir(), input.path, input.text, input.base),
  );
  server.handle(resolveNoteLinkRpc, async (input) =>
    resolveVaultLink(resolveVaultDir(), input.from, input.target),
  );

  // 連打対策: 同じノートの作成は1本に畳む(記録まで終わった後の分は上の `already` が受ける)。
  const opening = new Map<string, Promise<OpenConceptThreadOutput>>();

  server.handle(openConceptThreadRpc, async (input, ctx) => {
    const key = path.resolve(input.path);
    const inflight = opening.get(key);
    if (inflight) return inflight;
    // 想定外の例外でも、押した人に理由の文面が届くようにする(無言の失敗を作らない)。
    const task = openConceptThread(key, ctx)
      .catch(
        (error: unknown): OpenConceptThreadOutput => ({
          ok: false,
          threadId: null,
          created: false,
          record: "skipped",
          recordError: null,
          message: `スレを開けません: ${(error as Error).message}`,
        }),
      )
      .finally(() => {
        if (opening.get(key) === task) opening.delete(key);
      });
    opening.set(key, task);
    return task;
  });

  server.handle(cardChatAskRpc, async (input) => {
    try {
      return askFromPane(
        resolveConfirmBoxDir(),
        { id: input.id, key: input.key },
        input.text,
        input.target,
      );
    } catch (error) {
      return { ok: false, message: `送れません: ${(error as Error).message}` };
    }
  });

  server.handle(cardChatCancelRpc, async (input) => {
    try {
      return {
        ok: cancelFromPane(resolveConfirmBoxDir(), { id: input.id, key: input.key }, input.replyId),
      };
    } catch {
      return { ok: false };
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

/** 生存スレの索引。`live: false` はデーモンの一覧を読み切れていない(「無い」と断定できない)。 */
type LiveThreadIndex = Set<string> & { live?: boolean };

/** 生存スレ一覧を辿るページ数の上限(1ページ200件。届かなければ (1) へ縮退する)。 */
const LIVE_THREAD_PAGES_MAX = 25;
/** スレ作成の待ち上限(秒)。超えたら諦めるが、後から届いたIDは記録に回す。 */
const CREATE_TIMEOUT_MS = 60_000;
/** 前回諦めた作成がまだ続いているとき、次の押下が待つ時間。過ぎたら「作成中」と返す。 */
const PENDING_RETRY_WAIT_MS = 5_000;

/**
 * 深掘りスレを置く作業ディレクトリ。Paseo 本体の新規スレは「最後に使ったワークスペース」を
 * 既定にするが、その選択は端末側にあり插件からは読めない。読めるようになるまでは決まった場所
 * (`~/repos/_coordinator-spawned`、無ければホーム)に置く。`TOPOS_CONCEPT_THREAD_CWD` で差し替え可。
 */
function conceptThreadCwd(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TOPOS_CONCEPT_THREAD_CWD?.trim();
  if (configured) return configured;
  const spawned = path.join(os.homedir(), "repos", "_coordinator-spawned");
  try {
    if (fs.statSync(spawned).isDirectory()) return spawned;
  } catch {
    // 無ければホーム
  }
  return os.homedir();
}

/** スレの題名(サイドバーに出る)。 */
function conceptThreadTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return (t.length > 120 ? `${t.slice(0, 119)}…` : t) || "構想";
}

/** 深掘りスレの最初の発話(壁打ち開始)。ノートの1行結論があれば起点にする。 */
function conceptThreadPrompt(conclusion: string, notePath: string): string {
  const lines = ["この構想ノートの深掘り(壁打ち)を始めます。", `ノート: ${notePath}`];
  if (conclusion) lines.push(`いまの1行結論: ${conclusion}`);
  lines.push("まずこの構想の要点と、決まっていない点・分岐する選択肢を整理して提示してください。");
  return lines.join("\n");
}
