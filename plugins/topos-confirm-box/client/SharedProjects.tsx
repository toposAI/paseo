/**
 * サイドバーの「共有プロジェクト」タブの中身(`SharedProjectsList`)と、押して開く画面(`SharedProjectView`)。
 *
 * 参加している共有プロジェクトだけが出る(参加していないものは Topos 側が返さない。2026-10-27 ユーザー確認済み)。
 * 取得は Paseo のサーバー部が Topos の範囲つきトークンで行う(`server/shared-projects.ts`)。
 * 設定が無い/繋がらないときは、0件と区別して理由を行で出す。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import {
  POST_TEXT_MAX,
  canPost,
  emptyProjectsLabel,
  sharedProjectPostRpc,
  sharedProjectReadRpc,
  sharedProjectThreadRpc,
  sharedProjectsListRpc,
  shortTime,
  totalUnread,
  unreadLabel,
  type SharedMessage,
  type SharedProject,
} from "../shared/shared-projects.js";

export const SHARED_PROJECT_SCREEN_ID = "shared-project";
const POLL_MS = 60_000;
const THREAD_POLL_MS = 15_000;

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
    return () => {
      alive = false;
      clearInterval(timer);
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

/** 未読バッジ。要素は関数呼び出しで作る(JSX を prop に直書きしない lint 規約)。 */
function UnreadBadge({ label }: { label: string }): ReactElement | undefined {
  return label ? <Text style={badgeStyle}>{label}</Text> : undefined;
}

function ProjectRow({
  project,
  openScreen,
}: {
  project: SharedProject;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
}) {
  const press = useCallback(
    () => openScreen({ screenId: SHARED_PROJECT_SCREEN_ID, params: { id: project.id } }),
    [openScreen, project.id],
  );
  const badge = unreadLabel(project.unread);
  const trailing = UnreadBadge({ label: badge });
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

export function SharedProjectsList({
  openScreen,
}: {
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
}) {
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
    </>
  );
}

function MessageBubble({
  m,
  colors,
}: {
  m: SharedMessage;
  colors: PluginHostProps["theme"]["colors"];
}) {
  const box = useMemo(
    () => ({
      alignSelf: m.mine ? ("flex-end" as const) : ("flex-start" as const),
      maxWidth: "88%" as const,
      backgroundColor: m.mine ? colors.surface2 : colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 8,
      gap: 2,
    }),
    [m.mine, colors],
  );
  const head = useMemo(() => ({ color: colors.foregroundMuted, fontSize: 11 }), [colors]);
  const body = useMemo(() => ({ color: colors.foreground, fontSize: 14 }), [colors]);
  const to = m.to.length > 0 ? ` → ${m.to.join("・")}` : "";
  const att = m.attachments > 0 ? `(添付${m.attachments}件はToposで)` : "";
  return (
    <View style={box}>
      <Text style={head}>{`${m.author}${to} ・ ${shortTime(m.ts)}`}</Text>
      <Text style={body}>{`${m.text}${att ? ` ${att}` : ""}`}</Text>
    </View>
  );
}

function threadHeader(status: Status | "loading", count: number, note: string): string {
  if (status === "loading") return "読み込み中…";
  if (status === "ok") return count === 0 ? "まだ投稿はありません" : "";
  return note || emptyProjectsLabel(status);
}

export function SharedProjectView({
  theme,
  projectId,
}: Pick<PluginHostProps, "theme"> & { projectId: string | null }) {
  const thread = useRpc(sharedProjectThreadRpc);
  const post = useRpc(sharedProjectPostRpc);
  const markRead = useRpc(sharedProjectReadRpc);
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [status, setStatus] = useState<Status | "loading">("loading");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const c = theme.colors;

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await thread({ id: projectId });
      setStatus(r.status);
      setNote(r.message ?? "");
      if (r.status === "ok") {
        setMessages(r.messages);
        // 表示した分まで既読にする(失敗しても表示は続ける)
        if (r.unread > 0 && r.latestSeq > 0) {
          void markRead({ id: projectId, seq: r.latestSeq }).catch(() => {});
        }
      }
    } catch (e) {
      setStatus("error");
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, thread, markRead]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const send = useCallback(async () => {
    if (!projectId || sending || !canPost(text)) return;
    setSending(true);
    try {
      const r = await post({ id: projectId, text });
      if (r.ok) {
        setText("");
        setNote("");
        await reload();
      } else {
        setNote(r.message ?? "");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [projectId, sending, text, post, reload]);

  const sendPress = useCallback(() => {
    void send();
  }, [send]);

  const s = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: c.surface0 },
      list: { padding: 12, gap: 8 },
      note: { color: c.foregroundMuted, fontSize: 12, paddingHorizontal: 12, paddingTop: 8 },
      bar: {
        flexDirection: "row" as const,
        gap: 8,
        padding: 8,
        borderTopWidth: 1,
        borderTopColor: c.border,
        alignItems: "flex-end" as const,
      },
      input: {
        flex: 1,
        color: c.foreground,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        minHeight: 40,
        maxHeight: 140,
      },
      btn: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: canPost(text) && !sending ? c.accent : c.surface2,
      },
      btnText: { color: "#ffffff", fontWeight: "700" as const },
    }),
    [c, text, sending],
  );

  if (!projectId) return <Text style={s.note}>プロジェクトが選ばれていません</Text>;
  const header = threadHeader(status, messages.length, note);
  return (
    <View style={s.root}>
      {header ? <Text style={s.note}>{header}</Text> : null}
      <ScrollView contentContainerStyle={s.list}>
        {messages.map((m) => (
          <MessageBubble key={m.seq} m={m} colors={c} />
        ))}
      </ScrollView>
      {status === "ok" && note ? <Text style={s.note}>{note}</Text> : null}
      <View style={s.bar}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          placeholder="全員宛てに投稿(AIには聞きません)"
          placeholderTextColor={c.foregroundMuted}
          multiline
          maxLength={POST_TEXT_MAX}
        />
        <Pressable style={s.btn} onPress={sendPress} disabled={!canPost(text) || sending}>
          <Text style={s.btnText}>送信</Text>
        </Pressable>
      </View>
    </View>
  );
}
