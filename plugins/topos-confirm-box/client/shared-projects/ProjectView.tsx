/**
 * 共有プロジェクトの画面(サイドバーの項目・作成・アーカイブ・並び順から開く)。
 * Paseo の部品と配色で作る(Topos の画面は埋め込まない)。業務ロジックは Topos 側で、ここは `/api/family-projects` を
 * 許可リストの中継(`topos.projects.api`)で呼んで表示するだけ。
 *
 * 画面の振り分け: id=プロジェクト / "new"=作成 / "archived"=アーカイブ済み / "order"=並び順。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import {
  canWrite,
  isCreator,
  isId32,
  parseAiPending,
  parseConfig,
  parseDetail,
  type ProjectConfig,
  type ProjectDetail,
} from "../../shared/shared-projects-api.js";
import { useApi } from "./api.js";
import { CreateProject } from "./CreateProject.js";
import { InfoPane } from "./InfoPane.js";
import { ArchivedList, OrderList } from "./ManageList.js";
import { NotesPane } from "./NotesPane.js";
import { ThreadPane } from "./ThreadPane.js";
import type { OpenScreen, ProjectCtx } from "./types.js";
import { Banner, makeStyles, type S } from "./ui.js";
import { useAiRunner } from "./useAiRunner.js";
import { useThread } from "./useThread.js";

export const SCREEN_NEW = "new";
export const SCREEN_ARCHIVED = "archived";
export const SCREEN_ORDER = "order";

type Tab = "thread" | "notes" | "info";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "thread", label: "スレッド" },
  { id: "notes", label: "ノート" },
  { id: "info", label: "概要・メンバー" },
];

function TabButton({
  s,
  label,
  value,
  on,
  onPress,
}: {
  s: S;
  label: string;
  value: Tab;
  on: boolean;
  onPress: (t: Tab) => void;
}) {
  const press = useCallback(() => onPress(value), [onPress, value]);
  const state = useMemo(() => ({ selected: on }), [on]);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={state}
      accessibilityLabel={label}
      onPress={press}
      style={on ? s.tabOn : s.tab}
    >
      <Text style={on ? s.tabTextOn : s.tabText}>{label}</Text>
    </Pressable>
  );
}

function ProjectScreen({
  theme,
  id,
  title,
  openScreen,
}: {
  theme: PluginHostProps["theme"];
  id: string;
  title: string;
  openScreen: OpenScreen;
}) {
  const colors = theme.colors;
  const s = useMemo(() => makeStyles(colors), [colors]);
  const call = useApi();
  const [tab, setTab] = useState<Tab>("thread");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [limited, setLimited] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [kicking, setKicking] = useState(false);
  const [kickError, setKickError] = useState("");
  const kicked = useRef("");
  const ai = useAiRunner(id);
  const thread = useThread(call, id, tab === "thread");

  // プロジェクトが変わったら前の内容を持ち越さない
  useEffect(() => {
    setTab("thread");
    setDetail(null);
    setConfig(null);
    setLimited(false);
    setDetailError("");
    setKicking(false);
    setKickError("");
  }, [id]);

  const reloadDetail = useCallback(async () => {
    const r = await call("project", { id });
    if (r.ok) {
      setDetail(parseDetail(r.data));
      setDetailError("");
    } else if (r.reason === "not_found") {
      // 旧鍵は詳細の経路を持たないことがある。スレッドが見えるなら致命ではない
      setDetailError("");
    } else setDetailError(r.message);
  }, [call, id]);

  useEffect(() => {
    void reloadDetail();
    let alive = true;
    void call("config").then((r) => {
      if (!alive) return null;
      if (r.ok) setConfig(parseConfig(r.data));
      // 設定の経路が見つからない鍵 = 範囲が狭い旧鍵(宛先・添付・AI・ノートが使えない)
      else if (r.reason === "not_found" || r.reason === "scope") setLimited(true);
      return null;
    });
    return () => {
      alive = false;
    };
  }, [call, id, reloadDetail]);

  const me = thread.view?.me ?? "";
  const writable = !detail || me === "" ? true : canWrite(detail.members, me);
  const creator = isCreator(detail, me);

  // 作成直後(概要の聞き取り待ちでスレッドが空)は、AIの最初の質問を作成者の画面から始める
  const latest = thread.view?.latestSeq ?? -1;
  useEffect(() => {
    if (!detail?.overviewPending || !creator || limited || latest !== 0) return;
    if (kicked.current === id) return;
    kicked.current = id;
    setKicking(true);
    void call("kickoff", { id }).then(async (r) => {
      // 最初の質問の生成は Paseo 側。Topos が ai_pending を返したときだけジョブで作って保存する
      const pending = r.ok ? parseAiPending(r.data) : null;
      if (pending) {
        const res = await ai.run(pending);
        if (res.stale) return null;
        if (!res.ok && res.message) setKickError(res.message);
      }
      setKicking(false);
      await thread.reload();
      await reloadDetail();
      return null;
    });
  }, [detail?.overviewPending, creator, limited, latest, id, call, thread, reloadDetail, ai]);

  const ctx: ProjectCtx = useMemo(
    () => ({
      s,
      colors,
      call,
      id,
      detail,
      me,
      config,
      limited,
      writable,
      creator,
      reloadDetail,
      openScreen,
    }),
    [s, colors, call, id, detail, me, config, limited, writable, creator, reloadDetail, openScreen],
  );

  return (
    <View style={s.root}>
      <View style={s.page}>
        <Text style={s.title} numberOfLines={2}>
          {detail?.name ?? (title || "共有プロジェクト")}
        </Text>
        {detail?.description ? (
          <Text style={s.muted} numberOfLines={2}>
            {detail.description}
          </Text>
        ) : null}
        <Banner s={s} text={detailError} error />
        {limited ? (
          <Banner
            s={s}
            text="この鍵では本文の読み書きだけ使えます。宛先・添付・AI・ノート・メンバー管理はフル機能用の鍵(projects_full)が必要です"
          />
        ) : null}
        {kicking ? <Banner s={s} text="AIが考え中…(最初の質問を作っています)" /> : null}
        <Banner s={s} text={kickError} error />
      </View>
      <View style={s.tabs}>
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            s={s}
            label={t.label}
            value={t.id}
            on={tab === t.id}
            onPress={setTab}
          />
        ))}
      </View>
      {tab === "thread" ? <ThreadPane ctx={ctx} thread={thread} /> : null}
      {tab === "notes" ? (
        <ScrollView style={s.fill}>
          <NotesPane ctx={ctx} />
        </ScrollView>
      ) : null}
      {tab === "info" ? (
        <ScrollView style={s.fill}>
          <InfoPane ctx={ctx} />
        </ScrollView>
      ) : null}
    </View>
  );
}

export function SharedProjectView({
  theme,
  projectId,
  title,
  openScreen,
  screenId,
}: {
  theme: PluginHostProps["theme"];
  projectId: string | null;
  title: string;
  openScreen: OpenScreen;
  screenId: string;
}) {
  const colors = theme.colors;
  const s = useMemo(() => makeStyles(colors), [colors]);
  const call = useApi();
  if (!projectId)
    return (
      <View style={s.root}>
        <View style={s.page}>
          <Text style={s.muted}>プロジェクトが選ばれていません</Text>
        </View>
      </View>
    );
  if (projectId === SCREEN_NEW)
    return (
      <CreateProject
        s={s}
        colors={colors}
        call={call}
        openScreen={openScreen}
        screenId={screenId}
      />
    );
  if (projectId === SCREEN_ARCHIVED) return <ArchivedList s={s} call={call} />;
  if (projectId === SCREEN_ORDER) return <OrderList s={s} call={call} />;
  if (!isId32(projectId))
    return (
      <View style={s.root}>
        <View style={s.page}>
          <Text style={s.error}>不正なプロジェクトIDです</Text>
        </View>
      </View>
    );
  return <ProjectScreen theme={theme} id={projectId} title={title} openScreen={openScreen} />;
}
