/**
 * 行のアーカイブで「ワークスペースも閉じてよいか」の判定。
 *
 * Paseo のワークスペース archive は「ワークスペースが持つものを全部閉じる」ので
 * (`packages/server/src/server/workspace-archive-service.ts`)、共有ワークスペース
 * (司令塔ワークスペース等)を閉じると、そこに属する他のスレまで巻き込んで閉じてしまう。
 * よって閉じてよいのは、このスレ以外に生きている(idle/running/error/initializing)スレが
 * 無いときだけ。closed のスレは残っていても巻き込むものは無いので数えない。
 */
export interface WorkspaceMember {
  id: string;
  status: string;
  archived?: boolean;
}

const LIVE_STATUSES = new Set(["idle", "running", "error", "initializing"]);

/** `limit` は Paseo のページ上限(200)。これを超える規模のワークスペースは「他に生きているスレあり」とみなす(安全側)。 */
export const WORKSPACE_SCAN_LIMIT = 200;

export type WorkspaceArchiveDecision = { safe: true } | { safe: false; message: string };

export function decideWorkspaceArchive(
  selfId: string,
  members: WorkspaceMember[],
  pageHasMore: boolean,
): WorkspaceArchiveDecision {
  const others = members.filter(
    (m) => m.id !== selfId && m.archived !== true && LIVE_STATUSES.has(m.status),
  );
  if (others.length > 0) {
    return {
      safe: false,
      message: `スレをアーカイブしました。ワークスペースは他のスレ(${others.length}本)と共有しているため閉じませんでした`,
    };
  }
  if (pageHasMore) {
    return {
      safe: false,
      message: "スレをアーカイブしました。ワークスペースは共有の可能性があるため閉じませんでした",
    };
  }
  return { safe: true };
}
