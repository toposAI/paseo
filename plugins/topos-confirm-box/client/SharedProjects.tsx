/**
 * サイドバーの「共有プロジェクト」タブの中身(`SharedProjectsList`)。押して開く画面は `shared-projects/ProjectView.tsx`。
 *
 * 参加している共有プロジェクトだけが出る(参加していないものは Topos 側が返さない。2026-10-27 ユーザー確認済み)。
 * 取得は Paseo のサーバー部が Topos の範囲つきトークンで行う(`server/shared-projects.ts`)。
 * 設定が無い/繋がらないときは、0件と区別して理由を行で出す。
 * 作成・名前変更・アーカイブ・並べ替え・既読の後は、画面側の合図(onProjectsChanged)で一覧を取り直す。
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Text } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import {
  emptyProjectsLabel,
  sharedProjectsListRpc,
  totalUnread,
  unreadLabel,
  type SharedProject,
} from "../shared/shared-projects.js";
import { onProjectsChanged } from "./shared-projects/api.js";
import { SCREEN_ARCHIVED, SCREEN_NEW, SCREEN_ORDER } from "./shared-projects/ProjectView.js";

export { SharedProjectView } from "./shared-projects/ProjectView.js";

export const SHARED_PROJECT_SCREEN_ID = "shared-project";
const POLL_MS = 60_000;

type Status = "ok" | "unconfigured" | "error";

export interface SharedProjectsState {
  projects: SharedProject[];
  status: Status | "loading";
  message: string;
}

/** 一覧を60秒ごとに取る(サイドバー項目ごとに1回の購読)。失敗時は前回の一覧を残して理由を出す。 */
export function useSharedProjects(): SharedProjectsState {
  const list = useRpc(sharedProjectsListRpc);
  const [state, setState] = useState<SharedProjectsState>({
    projects: [],
    status: "loading",
    message: "",
  });
  useEffect(() => {
    let alive = true;
    const tick = () =>
      list({})
        .then((r) => {
          if (!alive) return null;
          setState((prev) => ({
            projects: r.status === "ok" ? r.projects : prev.projects,
            status: r.status,
            message: r.message ?? "",
          }));
          return null;
        })
        .catch((e: unknown) => {
          if (alive)
            setState((prev) => ({
              ...prev,
              status: "error",
              message: e instanceof Error ? e.message : String(e),
            }));
        });
    void tick();
    const timer = setInterval(tick, POLL_MS);
    // 画面側の変更(作成・既読・アーカイブ・並べ替え)をすぐ映す
    const off = onProjectsChanged(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [list]);
  return state;
}

/** 下部バー項目のバッジ用: 全プロジェクトの未読合計。 */
export function useSharedUnread(): number {
  const { projects } = useSharedProjects();
  return totalUnread(projects);
}

function noop(): void {}

function oneLine(s: string, max = 56): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const badgeStyle = { color: "#ffffff", fontSize: 10, fontWeight: "700" as const };

type OpenScreen = (input: { screenId: string; params?: Record<string, string> }) => void;

/** 未読バッジ。要素は関数呼び出しで作る(JSX を prop に直書きしない lint 規約)。 */
function UnreadBadge({ label }: { label: string }): ReactElement | undefined {
  return label ? <Text style={badgeStyle}>{label}</Text> : undefined;
}

function ProjectRow({ project, openScreen }: { project: SharedProject; openScreen: OpenScreen }) {
  const press = useCallback(
    () =>
      openScreen({
        screenId: SHARED_PROJECT_SCREEN_ID,
        params: { id: project.id, name: project.name },
      }),
    [openScreen, project.id, project.name],
  );
  // 自分宛てのメンションがあれば「@」を添える(件数は未読バッジ側)
  const badge = unreadLabel(project.unread);
  const trailing = UnreadBadge({ label: badge && project.mentions > 0 ? `@${badge}` : badge });
  return (
    <SidebarRow
      id={`shared-project-${project.id}`}
      icon="Users"
      label={oneLine(project.name)}
      onPress={press}
      trailing={trailing}
    />
  );
}

function ActionRow({
  id,
  icon,
  label,
  screen,
  openScreen,
}: {
  id: string;
  icon: "Plus" | "Archive" | "ArrowUpDown";
  label: string;
  screen: string;
  openScreen: OpenScreen;
}) {
  const press = useCallback(
    () => openScreen({ screenId: SHARED_PROJECT_SCREEN_ID, params: { id: screen } }),
    [openScreen, screen],
  );
  return <SidebarRow id={id} icon={icon} label={label} onPress={press} />;
}

export function SharedProjectsList({ openScreen }: { openScreen: OpenScreen }) {
  // このタブを開いている間だけ取得する(表示中のみ購読)。
  const { projects, status, message } = useSharedProjects();
  return (
    <>
      {status !== "ok" && status !== "loading" ? (
        <SidebarRow
          id="shared-projects-status"
          icon="CircleAlert"
          label={oneLine(message || emptyProjectsLabel(status), 80)}
          onPress={noop}
        />
      ) : null}
      {status === "ok" ? (
        <ActionRow
          id="shared-projects-new"
          icon="Plus"
          label="新しい共有プロジェクト"
          screen={SCREEN_NEW}
          openScreen={openScreen}
        />
      ) : null}
      {projects.map((p) => (
        <ProjectRow key={p.id} project={p} openScreen={openScreen} />
      ))}
      {status === "ok" && projects.length === 0 ? (
        <SidebarRow
          id="shared-projects-empty"
          icon="Users"
          label={emptyProjectsLabel("ok")}
          onPress={noop}
        />
      ) : null}
      {status === "ok" ? (
        <>
          {projects.length > 1 ? (
            <ActionRow
              id="shared-projects-order"
              icon="ArrowUpDown"
              label="並び順を変える"
              screen={SCREEN_ORDER}
              openScreen={openScreen}
            />
          ) : null}
          <ActionRow
            id="shared-projects-archived"
            icon="Archive"
            label="アーカイブ済み"
            screen={SCREEN_ARCHIVED}
            openScreen={openScreen}
          />
        </>
      ) : null}
    </>
  );
}
