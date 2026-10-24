/**
 * サイドバーの「構想一覧」タブの中身(`ConceptNotesList`)と、**スレ一覧の実装ノートの重ね合わせ**。
 *
 * 2026-10-24 のタブ化で、構想はスレ一覧の下に積まずタブで出す(`client/ChildThreadsSidebar.tsx`)。
 *
 * - status の正は Vault ノートの frontmatter(標準_サイドバーの表示ルール)。この画面は書かない。
 * - 構想一覧: 構想/壁打ち中の構想ノート。行は**短縮した題名だけ**(決定的に切り詰める)。
 *   押すとその構想の**深掘りスレ**を開く。スレが無ければサーバー側が1本作り、IDをノートの
 *   `thread:` へ記録する(2026-10-23 決定)。**連打対策はサーバー**: 同じノートの作成は1本に
 *   畳まれるので、ここでは画面側のフラグ(`creating`)でサーバーを叩く回数も1回に絞るだけ。
 * - スレの有無は行右端の**小さなアイコン**で示す(2026-10-24 ユーザー指示)。
 * - 「あとで」(今は見ない構想)は行の ⋯ メニューで移す。一覧の下の畳んだ見出しから開ける
 *   (`Paseo/構想/{検討中,あとで}` の置き場が在るときだけ。無ければ今までどおり平らに並べる)。
 * - スレ一覧: 実装ノート(status=実装中/判断待ち/確認待ち)を子スレの行に重ねる(`useSidebarNotes`)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { moveConceptNoteRpc, notesSidebarRpc, openConceptThreadRpc } from "../shared/notes.js";
import type { NoteStatus, SidebarNote } from "../shared/notes.js";
import type { ConceptZone, SidebarPlace, ZoneCounts } from "../shared/concept-places.js";
import { indexImplementationNotes, lowerTierNotes } from "../shared/sidebar-rows.js";
import { emptySectionLabel } from "../shared/sidebar-section-mode.js";
import {
  conceptRowFullLabel,
  conceptRowTitle,
  conceptSections,
  conceptThreadBadge,
  conceptThreadBadgeLabel,
  laterSectionLabel,
} from "../shared/concept-row.js";
import type { ConceptThreadBadge } from "../shared/concept-row.js";
import { ConceptMenuButton, ConceptRowMenu } from "./ConceptRowMenu.js";

const POLL_MS = 60_000;
/** 作成に失敗した理由の表示時間。消えないと、直した後も残って見える。 */
const NOTICE_MS = 8_000;
const LOWER_COLLAPSED_KEY = "topos-concept-notes-collapsed";
const LATER_OPEN_KEY = "topos-concept-later-open";
/** 行の主アイコン(status。構想=灯火 / 壁打ち中=吹き出し)。 */
const CONCEPT_ICON: Record<NoteStatus, string> = {
  構想: "Lightbulb",
  壁打ち中: "MessageCircle",
  実装中: "Loader",
  判断待ち: "CircleHelp",
  確認待ち: "CircleCheck",
  完了: "CircleCheck",
};
/** 行右端の小さな印(スレ未作成/未解決のときだけ。スレありは印なし=既定の見た目)。 */
const BADGE_ICON: Record<Exclude<ConceptThreadBadge, "thread">, string> = {
  unresolved: "MessageCircleOff",
  none: "MessageCircleDashed",
};
/** スレ未作成の印の色(WCAG AA 3:1 を満たす濃さ。テーマの色を使う行の文字とは別)。 */
const UNCREATED_BADGE_COLOR = "#f59e0b";
const UNRESOLVED_BADGE_COLOR = "#a16207";
const CHEVRON = { open: "▾", closed: "▸" } as const;
type SidebarColors = PluginSidebarItemProps["theme"]["colors"];
/** 旧置き場だけのときの件数(「あとで」の区分は無い)。 */
const LEGACY_ZONES: ZoneCounts = Object.freeze({
  active: 0,
  later: 0,
  laterAvailable: false,
});
/** `colors` を渡さない呼び出し(旧画面)のときの配色。 */
const LIGHT_COLORS = {
  surface1: "#ffffff",
  border: "#d4d4d8",
  foreground: "#18181b",
  foregroundMuted: "#52525b",
} as unknown as SidebarColors;

export interface SidebarNotesState {
  notes: SidebarNote[];
  error: string | null;
  /** 構想の置き場(新置き場 `Paseo/構想` を読んでいるか、旧置き場だけか)。 */
  place: SidebarPlace;
  /** 構想の件数(検討中/あとで)と、移動できるか(両方の置き場が在るか)。 */
  zones: ZoneCounts;
  /** 実装ノートをスレIDで引く(無ければ undefined)。 */
  implByThread: ReadonlyMap<string, SidebarNote>;
  /** すぐに取り直す(スレを作ってノートへ記録した後。ドラッグ中のゲートは越える)。 */
  reload: () => void;
}

/**
 * ノート一覧を取得する(サイドバー項目ごとに1回)。
 * `gate` を渡すと、その時刻までは取得結果を反映しない(ドラッグ中に行が飛ばないように)。
 * 取得は**発番**し、後から投げた取得の結果だけを反映する(`seq`)。移動・スレ作成の直後に
 * 古い一覧が遅れて届き、行が元の区分へ戻って見えるのを防ぐ。
 */
export function useSidebarNotes(gate?: { current: number }): SidebarNotesState {
  const list = useRpc(notesSidebarRpc);
  const [notes, setNotes] = useState<SidebarNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<SidebarPlace>("legacy");
  const [zones, setZones] = useState<ZoneCounts>({
    active: 0,
    later: 0,
    laterAvailable: false,
  });

  // スレを作った直後の取り直しは、ドラッグ中のゲートを越えて届ける必要がある
  // (ノートの `thread:` に記録したIDを、次の60秒を待たずに反映する)。
  const fetchRef = useRef<(force?: boolean) => void>(() => {});

  // 最後に投げた取得と、最後に反映した取得の発番(返ってきた順と投げた順が違っても新しい方だけ)。
  // 捨てる判定は appliedRef だけで行う: sentRef と比べると、ゲート中に投げた取得が遅く返ったとき、
  // その後ろに並んだ force の結果を最新として通せなくなる。
  const sentRef = useRef(0);
  const appliedRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = (force = false) => {
      const seq = ++sentRef.current;
      return list({})
        .then((r) => {
          if (!alive) return null;
          // 自分より後に投げた取得が既にある/反映済みなら捨てる(古い区分へ戻さない)。
          if (seq < appliedRef.current) return null;
          if (!force && gate && Date.now() < gate.current) return null;
          appliedRef.current = seq;
          // 内容が同じなら配列を差し替えない(60秒ごとに一覧を丸ごと再描画しない。
          // ドラッグ中に行が飛ぶのも、この再描画が原因になりうる)。
          setNotes((prev) => (sameNotes(prev, r.notes) ? prev : r.notes));
          setError(r.error ?? (r.truncated ? "ノートの走査が途中で打ち切られました" : null));
          setPlace(r.place);
          setZones(r.zones);
          return null;
        })
        .catch(() => {
          // 失敗した古い取得で、新しい取得の結果を上書きしない
          if (alive && seq === sentRef.current) setError("ノートを取得できません");
          return null;
        });
    };
    fetchRef.current = tick;
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [list, gate]);

  const reload = useCallback(() => fetchRef.current(true), []);

  // 実装ノートをスレIDで引く(規則は shared/sidebar-rows.ts の indexImplementationNotes だけ)。
  const implByThread = useMemo(() => indexImplementationNotes(notes), [notes]);
  return { notes, error, place, zones, implByThread, reload };
}

/** 2つのノート一覧が表示上同じか(パス・種類・区分・移せるか・status・題名・結論・スレ・更新時刻)。 */
function sameNotes(a: readonly SidebarNote[], b: readonly SidebarNote[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.path === y.path &&
      x.kind === y.kind &&
      x.zone === y.zone &&
      (x.movable ?? false) === (y.movable ?? false) &&
      x.status === y.status &&
      x.title === y.title &&
      x.conclusion === y.conclusion &&
      x.threadId === y.threadId &&
      x.updatedAt === y.updatedAt
    );
  });
}

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(LOWER_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(LOWER_COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    // 保存できなくても画面上の開閉は動く
  }
}

function readLaterOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(LATER_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLaterOpen(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(LATER_OPEN_KEY, v ? "1" : "0");
  } catch {
    // 保存できなくても画面上の開閉は動く
  }
}

/** 押しても何もしない行(タブ表示の空行)。`SidebarRow` は `onPress` 必須なので定数を渡す。 */
function noop(): void {}

function oneLine(s: string, max = 56): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface ConceptNotesListProps {
  notes: readonly SidebarNote[];
  error: string | null;
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
  /** 補助的な文字の色(WCAG AA を満たすものを親が選ぶ)。 */
  statusColor: string;
  /** 構想の置き場(`useSidebarNotes` の戻り。省略時は旧置き場として平らに並べる)。 */
  place?: SidebarPlace;
  /** 構想の件数と「あとで」の可否(`useSidebarNotes` の戻り)。 */
  zones?: ZoneCounts;
  /** 行メニューの配色(親のテーマ。省略時は明るいテーマ相当)。 */
  colors?: SidebarColors;
  /** スレを作ってノートへ記録した直後に呼ぶ(一覧をすぐ取り直す)。 */
  onCreated?: () => void;
  /**
   * 見出し(件数+開閉)を出すか。タブの「構想一覧」では出さない(タブ自体が入口。
   * 2026-10-24 指示: 見出しを積まない)。既定は出さない。
   */
  header?: boolean;
}

export function ConceptNotesList({
  notes,
  error,
  openAgent,
  serverId,
  openScreen,
  statusColor,
  onCreated,
  place = "legacy",
  zones = LEGACY_ZONES,
  colors = LIGHT_COLORS,
  header = false,
}: ConceptNotesListProps) {
  const [open, setOpen] = useState(() => !readCollapsed());
  // 「あとで」は畳んで置く(既定)。開いた状態だけ覚える。
  const [laterOpen, setLaterOpen] = useState(() => readLaterOpen());
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const openThread = useRpc(openConceptThreadRpc);
  const moveNote = useRpc(moveConceptNoteRpc);
  // 作成中のノート(サーバーが1本に畳むが、画面からも連打で2回叩かない)。
  const creatingRef = useRef<Set<string>>(new Set());
  const [creating, setCreating] = useState<ReadonlySet<string>>(() => new Set());
  // 移動中のノート(同じ理由で画面側でも1回に畳む)。
  const movingRef = useRef<Set<string>>(new Set());
  const [moving, setMoving] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; sticky: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const concepts = useMemo(() => lowerTierNotes(notes), [notes]);
  // 「検討中」と「あとで」に分ける(区分の正はサーバーが付けた `zone`。旧置き場は全部 active)。
  const active = useMemo(() => concepts.filter((n) => n.zone === "active"), [concepts]);
  const later = useMemo(() => concepts.filter((n) => n.zone === "later"), [concepts]);
  const sections = useMemo(() => conceptSections(place, zones), [place, zones]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      writeCollapsed(v);
      return !v;
    });
  }, []);

  const toggleLater = useCallback(() => {
    setLaterOpen((v) => {
      writeLaterOpen(!v);
      return !v;
    });
  }, []);

  const toggleMenu = useCallback(
    (path: string) => setMenuPath((cur) => (cur === path ? null : path)),
    [],
  );

  const jumpTo = useCallback(
    (agentId: string) => {
      if (openAgent) openAgent({ agentId, serverId });
      else openScreen({ screenId: "child-threads", params: { focusId: agentId } });
    },
    [openAgent, openScreen, serverId],
  );

  const dismissNotice = useCallback(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(null);
  }, []);

  /**
   * 理由を出す。`sticky`(記録できていない = 次に押すと2本目になる状態)は、
   * 見逃すと困るので**自動では消さない**。タップで消す。
   */
  const showFailure = useCallback((text: string, sticky = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, sticky });
    if (!sticky) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  /** 右端の印(スレ未作成/未解決)を押したときの説明(SDK に Tooltip が無いため通知行で出す)。 */
  const explainBadge = useCallback(
    (n: SidebarNote) => {
      showFailure(`${n.title}: ${conceptThreadBadgeLabel(conceptThreadBadge(n))}`);
    },
    [showFailure],
  );

  /** 行メニューの「あとで」/「検討中に戻す」。結果は一覧の取り直しと1行の通知で返す。 */
  const move = useCallback(
    (n: SidebarNote) => {
      const to: ConceptZone = n.zone === "active" ? "later" : "active";
      setMenuPath(null);
      if (movingRef.current.has(n.path)) return;
      movingRef.current.add(n.path);
      setMoving(new Set(movingRef.current));
      void moveNote({ path: n.path, to })
        .then((r) => {
          // 成功は8秒で消える通知、失敗(権限・置き場なしなど)は自分で消すまで残す
          showFailure(`${n.title}: ${r.message}`, !r.ok);
          if (r.ok) {
            onCreated?.(); // 一覧をすぐ取り直す(次の60秒を待たず行を移す)
            // 検討中に戻した直後は「あとで」を畳み直して、戻した行が見えるようにする
            if (to === "active") {
              setLaterOpen(false);
              writeLaterOpen(false);
            }
          }
          return null;
        })
        .catch((e: unknown) => showFailure(`${n.title}: 移せません(${(e as Error).message})`))
        .finally(() => {
          movingRef.current.delete(n.path);
          setMoving(new Set(movingRef.current));
        });
    },
    [moveNote, onCreated, showFailure],
  );

  const press = useCallback(
    (n: SidebarNote) => {
      if (n.threadId) {
        jumpTo(n.threadId);
        return;
      }
      // スレ未作成: 深掘りスレを作って記録する(連打は作成中のフラグで1回に畳む)。
      if (creatingRef.current.has(n.path)) return;
      creatingRef.current.add(n.path);
      setCreating(new Set(creatingRef.current));
      void openThread({ path: n.path })
        .then((r) => {
          if (r.ok && r.threadId) {
            onCreated?.();
            jumpTo(r.threadId);
            // 記録に失敗してもスレは開ける。サーバーは次回に作り直さず記録を再試行するが、
            // デーモン再起動後は控えが消えるので、消えない通知で知らせる(出口レビュー round1 指摘1)。
            if (r.record === "conflict") {
              showFailure(`${n.title}: ノートの thread: に別のIDがあるため記録していません`, true);
            } else if (r.record === "pending" || r.record === "skipped") {
              showFailure(
                `${n.title}: スレは作りましたがノートに記録できていません${r.recordError ? `(${r.recordError})` : ""}`,
                true,
              );
            } else {
              dismissNotice();
            }
            // スレはできたが**最初の発話が失敗**した(受付外モデル・残高・承認待ちなど)。
            // 開くだけでは「中身がエラー1行」で開かないように見えるので、理由を消えない通知に出す。
            if (r.startError) showFailure(`${n.title}: ${r.startError}`, true);
            return;
          }
          showFailure(`${n.title}: スレを作れません${r.message ? `(${r.message})` : ""}`, true);
          return;
        })
        .catch((e: unknown) => showFailure(`${n.title}: スレを作れません(${(e as Error).message})`))
        .finally(() => {
          creatingRef.current.delete(n.path);
          setCreating(new Set(creatingRef.current));
        });
    },
    [dismissNotice, jumpTo, onCreated, openThread, showFailure],
  );

  const headerLabel =
    error && active.length === 0 ? "進行中の構想(取得失敗)" : `進行中の構想 ${active.length}件`;

  /**
   * 行を出すか。**見出しの無いタブ表示では保存された開閉状態を無視する**(出口レビュー round1 指摘1)。
   * 以前は畳んだ状態が `localStorage` に残っていると、見出しもシェブロンも無いタブで
   * 構想が1件も出ず、開き直す手段が無かった。
   */
  const visible = header ? open : true;

  const headerTrailing = useMemo(
    () => (
      <ConceptHeaderTrailing
        count={active.length}
        open={open}
        onToggle={toggle}
        color={statusColor}
      />
    ),
    [active.length, open, statusColor, toggle],
  );

  const laterTrailing = useMemo(
    () => <SectionChevron open={laterOpen} color={statusColor} label="あとで" />,
    [laterOpen, statusColor],
  );

  const rowProps = useMemo(
    () => ({
      creating,
      moving,
      menuPath,
      onPress: press,
      onToggleMenu: toggleMenu,
      onMove: move,
      onBadge: explainBadge,
      color: statusColor,
      colors,
    }),
    [colors, creating, explainBadge, menuPath, move, moving, press, statusColor, toggleMenu],
  );
  const renderRow = useCallback(
    (n: SidebarNote) => <ConceptRow key={n.path} note={n} {...rowProps} />,
    [rowProps],
  );

  const showError = visible && Boolean(error) && concepts.length === 0;
  const showEmpty = visible && !error && active.length === 0;

  return (
    <>
      {header ? (
        <SidebarRow
          id="concept-notes-header"
          icon="Lightbulb"
          label={headerLabel}
          onPress={toggle}
          trailing={headerTrailing}
        />
      ) : null}
      {/* 取得失敗は、見出しの無いタブでも黙って出さない(空と見分けが付かない) */}
      {showError ? (
        <SidebarRow
          id="concept-notes-error"
          icon="CircleAlert"
          label={oneLine(error ?? "", 80)}
          onPress={noop}
        />
      ) : null}
      {visible ? active.map(renderRow) : null}
      <ConceptLaterSection
        sections={sections}
        count={later.length}
        open={laterOpen}
        onToggle={toggleLater}
        trailing={laterTrailing}
        notes={later}
        rowProps={rowProps}
      />
      {visible && notice ? (
        <SidebarRow
          id="concept-notes-notice"
          icon="CircleAlert"
          label={oneLine(notice.text, 80)}
          onPress={dismissNotice}
        />
      ) : null}
      {/* 空行は見出しの開閉を兼ねる。見出しの無いタブで押すと畳んで空になるので、押下を付けない
          (構想タブ出口レビュー round1 指摘1)。取得失敗のときは空行を出さない(「取得失敗」と
          「何もない」を同時に言わない。同レビューの指摘)。 */}
      {showEmpty ? (
        <SidebarRow
          id="concept-notes-empty"
          icon="Lightbulb"
          label={emptySectionLabel("concepts")}
          onPress={header ? toggle : noop}
        />
      ) : null}
    </>
  );
}

/**
 * 「あとで」の区分(2026-10-24 ユーザー指示)。**畳んだ小さなフォルダ風の見出し1行**と、
 * 開いたときの中身だけを出す。旧置き場(`showLater=false`)では何も出さない。
 */
function ConceptLaterSection({
  sections,
  count,
  open,
  onToggle,
  trailing,
  notes,
  rowProps,
}: {
  sections: { showLater: boolean; laterToggle: boolean };
  count: number;
  open: boolean;
  onToggle: () => void;
  trailing: React.ReactElement;
  notes: readonly SidebarNote[];
  rowProps: ConceptRowProps;
}) {
  if (!sections.showLater) return null;
  // 畳めない状態(置き場が片方だけ)では中身を開いたまま出す。畳んだままだと開く手段が無く、
  // 「あとで」のノートがどの区分にも出ず見えなくなる。
  const expand = sections.laterToggle ? open : true;
  return (
    <>
      <SidebarRow
        id="concept-notes-later"
        icon="Folder"
        label={laterSectionLabel(count)}
        onPress={sections.laterToggle ? onToggle : noop}
        trailing={sections.laterToggle ? trailing : undefined}
      />
      {expand ? notes.map((n) => <ConceptRow key={n.path} note={n} {...rowProps} />) : null}
    </>
  );
}

function ConceptHeaderTrailing({
  count,
  open,
  onToggle,
  color,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  color: string;
}) {
  const countStyle = useMemo(() => ({ color }), [color]);
  const chevronStyle = useMemo(() => [styles.chevron, { color }], [color]);
  return (
    <View style={styles.trailing}>
      <Text style={countStyle}>{count}</Text>
      <Pressable
        onPress={onToggle}
        testID="concept-notes-toggle"
        accessibilityRole="button"
        accessibilityLabel={open ? "構想をたたむ" : "構想を開く"}
        hitSlop={8}
        style={styles.toggleHit}
      >
        <Text style={chevronStyle}>{open ? CHEVRON.open : CHEVRON.closed}</Text>
      </Pressable>
    </View>
  );
}

/** 区分の見出し(「あとで」)の右端のシェブロン。見出し行全体の押下で開閉する。 */
function SectionChevron({ open, color, label }: { open: boolean; color: string; label: string }) {
  const style = useMemo(() => [styles.chevron, { color }], [color]);
  return (
    <View style={styles.trailing} accessibilityLabel={`${label}を${open ? "たたむ" : "開く"}`}>
      <Text style={style}>{open ? CHEVRON.open : CHEVRON.closed}</Text>
    </View>
  );
}

/** 一覧側で1回作って行へ配る props(行ごとの `busy`/`menuOpen` は一覧の集合とパスで決まる)。 */
interface ConceptRowProps {
  /** 作成中のノート。 */
  creating: ReadonlySet<string>;
  /** 移動中のノート。 */
  moving: ReadonlySet<string>;
  /** メニューを開いているノート(1件だけ)。 */
  menuPath: string | null;
  colors: SidebarColors;
  onPress: (n: SidebarNote) => void;
  onToggleMenu: (path: string) => void;
  onMove: (n: SidebarNote) => void;
  onBadge: (n: SidebarNote) => void;
  color: string;
}

/**
 * 構想1行。題名は短縮して1行に収め、**状態の文字は出さない**(2026-10-24 ユーザー指示)。
 * - 右端: スレ未作成/未解決の印(小さなアイコン)と、行メニューの入口(⋯)。
 * - 印を押すと、その意味を1行の通知で出す(SDK に Tooltip が無いため。`conceptThreadBadgeLabel`)。
 * - 移動(あとで/検討中)の ⋯ は、その行が移せる(`movable`: 置き場の直下・両方の置き場が在る)ときだけ。
 */
function ConceptRow({ note: n, ...p }: ConceptRowProps & { note: SidebarNote }) {
  const { creating, moving: movingSet, menuPath, colors, color } = p;
  const { onPress, onToggleMenu, onMove, onBadge } = p;
  const busy = creating.has(n.path);
  const moving = movingSet.has(n.path);
  const menuOpen = menuPath === n.path;
  const press = useCallback(() => onPress(n), [onPress, n]);
  const toggleMenu = useCallback(() => onToggleMenu(n.path), [onToggleMenu, n.path]);
  const doMove = useCallback(() => onMove(n), [onMove, n]);
  const explain = useCallback(() => onBadge(n), [onBadge, n]);
  const title = conceptRowTitle(n);
  const full = conceptRowFullLabel(n);
  const badge = conceptThreadBadge(n);

  const trailing = useMemo(() => {
    if (busy) return <ActivityIndicator size="small" />;
    return (
      <View style={styles.trailing}>
        {badge === "thread" ? null : <ThreadBadge kind={badge} title={full} onPress={explain} />}
        {n.movable ? (
          <ConceptMenuButton
            title={full}
            open={menuOpen}
            moving={moving}
            color={color}
            onPress={toggleMenu}
          />
        ) : null}
      </View>
    );
  }, [badge, busy, color, explain, full, menuOpen, moving, n.movable, toggleMenu]);

  return (
    <>
      <SidebarRow
        id={`concept-${n.path}`}
        icon={CONCEPT_ICON[n.status]}
        label={title}
        onPress={press}
        trailing={trailing}
      />
      {menuOpen ? (
        <ConceptRowMenu zone={n.zone} title={full} busy={moving} colors={colors} onMove={doMove} />
      ) : null}
    </>
  );
}

/**
 * スレ未作成/未解決の小さな印。押すと説明が出る(`ConceptRow` の `trailing` 内。親へ通知を渡す)。
 * 役割は `button`(押すと動作がある)。`image` だと読み上げで「操作できない」と扱われる。
 */
function ThreadBadge({
  kind,
  title,
  onPress,
}: {
  kind: "none" | "unresolved";
  title: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={`concept-thread-badge-${kind}`}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${conceptThreadBadgeLabel(kind, "press")}`}
      hitSlop={6}
      onPress={onPress}
      style={styles.badgeHit}
    >
      <Icon
        name={BADGE_ICON[kind]}
        size={14}
        color={kind === "none" ? UNCREATED_BADGE_COLOR : UNRESOLVED_BADGE_COLOR}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trailing: { flexDirection: "row", alignItems: "center", gap: 4 },
  chevron: { fontSize: 11 },
  toggleHit: { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" },
  badgeHit: { minWidth: 20, minHeight: 32, alignItems: "center", justifyContent: "center" },
});
