import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";

/**
 * プラグインの面を右カラムへ置くときの決め方(2026-10-30)。
 *
 * 右カラムは「ワークスペースの右に作ったペイン」で、中身はタブの並び。欄には既に別の物(会話・別の面)が
 * 開いていることがあるので、そこへ入れるときは前に出すか後ろへ回すかを選ぶ:
 * - `front` … ボタンで開いたとき。入れた面を前へ出す(今までどおり)。
 * - `behind` … 自動で入れたとき。**ユーザーが自分で置いた物を隠さない**よう、後ろへ足して今の物を前のままにする。
 *   欄が空・既にこの面が出ているときは、どちらも前へ出る(重ならないので隠れる物が無い)。
 *
 * 欄が作れなかった(狭い画面など)ときは主ペインへ入れる(`undefined`)。
 * `pane` は既存タブもそのペインへ動かすので、`prefer`(新規タブだけそのペインへ)を使う。
 */
export function rightColumnPlacement(
  paneId: string | null,
  mode: "front" | "behind",
): WorkspaceTabPlacement | undefined {
  if (!paneId) return undefined;
  return mode === "front" ? { mode: "pane", paneId } : { mode: "prefer", paneId };
}
