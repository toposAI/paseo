/**
 * サイドバーの「構想一覧」タブの中身(`ConceptNotesList`)と、**スレ一覧の実装ノートの重ね合わせ**。
 *
 * 2026-10-24 のタブ化で、構想はスレ一覧の下に積まずタブで出す(`client/ChildThreadsSidebar.tsx`)。
 *
 * - status の正は Vault ノートの frontmatter(標準_サイドバーの表示ルール)。この画面は書かない。
 * - 構想一覧: 構想/壁打ち中の構想ノート。行は「題名 — 1行の結論」。押すとその構想の**深掘りスレ**を開く。
 *   スレが無ければサーバー側が1本作り、IDをノートの `thread:` へ記録する(2026-10-23 決定)。
 *   **連打対策はサーバー**: 同じノートの作成は1本に畳まれるので、ここでは画面側のフラグ
 *   (`creating`)でサーバーを叩く回数も1回に絞るだけ。
 * - スレ一覧: 実装ノート(status=実装中/判断待ち/確認待ち)を子スレの行に重ねる(`useSidebarNotes`)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { notesSidebarRpc, openConceptThreadRpc } from "../shared/notes.js";
import type { NoteStatus, SidebarNote } from "../shared/notes.js";
import { indexImplementationNotes, lowerTierNotes } from "../shared/sidebar-rows.js";
import { emptySectionLabel } from "../shared/sidebar-section-mode.js";

const POLL_MS = 60_000;
/** 作成に失敗した理由の表示時間。消えないと、直した後も残って見える。 */
const NOTICE_MS = 8_000;
const LOWER_COLLAPSED_KEY = "topos-concept-notes-collapsed";
const CONCEPT_ICON: Record<NoteStatus, string> = {
  構想: "Lightbulb",
  壁打ち中: "MessageCircle",
  実装中: "Loader",
  判断待ち: "CircleHelp",
  確認待ち: "CircleCheck",
  完了: "CircleCheck",
};
const CHEVRON = { open: "▾", closed: "▸" } as const;

export interface SidebarNotesState {
  notes: SidebarNote[];
  error: string | null;
  /** 実装ノートをスレIDで引く(無ければ undefined)。 */
  implByThread: ReadonlyMap<string, SidebarNote>;
  /** すぐに取り直す(スレを作ってノートへ記録した後。ドラッグ中のゲートは越える)。 */
  reload: () => void;
}

/**
 * ノート一覧を取得する(サイドバー項目ごとに1回)。
 * `gate` を渡すと、その時刻までは取得結果を反映しない(ドラッグ中に行が飛ばないように)。
 */
export function useSidebarNotes(gate?: { current: number }): SidebarNotesState {
  const list = useRpc(notesSidebarRpc);
  const [notes, setNotes] = useState<SidebarNote[]>([]);
  const [error, setError] = useState<string | null>(null);

  // スレを作った直後の取り直しは、ドラッグ中のゲートを越えて届ける必要がある
  // (ノートの `thread:` に記録したIDを、次の60秒を待たずに反映する)。
  const fetchRef = useRef<(force?: boolean) => void>(() => {});

  useEffect(() => {
    let alive = true;
    const tick = (force = false) =>
      list({})
        .then((r) => {
          if (!alive) return null;
          if (!force && gate && Date.now() < gate.current) return null;
          // 内容が同じなら配列を差し替えない(60秒ごとに一覧を丸ごと再描画しない。
          // ドラッグ中に行が飛ぶのも、この再描画が原因になりうる)。
          setNotes((prev) => (sameNotes(prev, r.notes) ? prev : r.notes));
          setError(r.error ?? (r.truncated ? "ノートの走査が途中で打ち切られました" : null));
          return null;
        })
        .catch(() => alive && setError("ノートを取得できません"));
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
  return { notes, error, implByThread, reload };
}

/** 2つのノート一覧が表示上同じか(パス・種類・status・題名・結論・スレ・更新時刻)。 */
function sameNotes(a: readonly SidebarNote[], b: readonly SidebarNote[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.path === y.path &&
      x.kind === y.kind &&
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

/** 押しても何もしない行(タブ表示の空行)。`SidebarRow` は `onPress` 必須なので定数を渡す。 */
function noop(): void {}

function oneLine(s: string, max = 56): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function conceptLabel(n: SidebarNote): string {
  return n.conclusion ? `${n.title} — ${oneLine(n.conclusion)}` : n.title;
}

/** スレIDが書かれているのに解決できない(短縮形・アーカイブ済み)かを、未作成と区別して出す。 */
function conceptStatus(n: SidebarNote): string {
  if (n.threadId) return n.status;
  return n.threadCandidates.length > 0 ? `${n.status}(スレ未解決)` : `${n.status}(スレ未作成)`;
}

export interface ConceptNotesListProps {
  notes: readonly SidebarNote[];
  error: string | null;
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
  /** 行右端の状態文字の色(WCAG AA を満たすものを親が選ぶ)。 */
  statusColor: string;
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
  header = false,
}: ConceptNotesListProps) {
  const [open, setOpen] = useState(() => !readCollapsed());
  const openThread = useRpc(openConceptThreadRpc);
  // 作成中のノート(サーバーが1本に畳むが、画面からも連打で2回叩かない)。
  const creatingRef = useRef<Set<string>>(new Set());
  const [creating, setCreating] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; sticky: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const concepts = useMemo(() => lowerTierNotes(notes), [notes]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      writeCollapsed(v);
      return !v;
    });
  }, []);

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

  const jumpTo = useCallback(
    (agentId: string) => {
      if (openAgent) openAgent({ agentId, serverId });
      else openScreen({ screenId: "child-threads", params: { focusId: agentId } });
    },
    [openAgent, openScreen, serverId],
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
    error && concepts.length === 0 ? "進行中の構想(取得失敗)" : `進行中の構想 ${concepts.length}件`;

  /**
   * 行を出すか。**見出しの無いタブ表示では保存された開閉状態を無視する**(出口レビュー round1 指摘1)。
   * 以前は畳んだ状態が `localStorage` に残っていると、見出しもシェブロンも無いタブで
   * 構想が1件も出ず、開き直す手段が無かった。
   */
  const visible = header ? open : true;

  const headerTrailing = useMemo(
    () => (
      <ConceptHeaderTrailing
        count={concepts.length}
        open={open}
        onToggle={toggle}
        color={statusColor}
      />
    ),
    [concepts.length, open, statusColor, toggle],
  );

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
      {visible && error && concepts.length === 0 ? (
        <SidebarRow
          id="concept-notes-error"
          icon="CircleAlert"
          label={oneLine(error, 80)}
          onPress={noop}
        />
      ) : null}
      {visible
        ? concepts.map((n) => (
            <ConceptRow
              key={n.path}
              note={n}
              busy={creating.has(n.path)}
              onPress={press}
              color={statusColor}
            />
          ))
        : null}
      {visible && notice ? (
        <SidebarRow
          id="concept-notes-notice"
          icon="CircleAlert"
          label={oneLine(notice.text, 80)}
          onPress={dismissNotice}
        />
      ) : null}
      {/* 空行は見出しの開閉を兼ねる。見出しの無いタブで押すと畳んで空になるので、押下を付けない
          (出口レビュー round1 指摘1) */}
      {/* 取得失敗のときは空行を出さない(「取得失敗」と「何もない」を同時に言わない。
          出口レビュー round2 指摘5) */}
      {visible && !error && concepts.length === 0 ? (
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

function ConceptRow({
  note: n,
  busy,
  onPress,
  color,
}: {
  note: SidebarNote;
  busy: boolean;
  onPress: (n: SidebarNote) => void;
  color: string;
}) {
  const press = useCallback(() => onPress(n), [onPress, n]);
  const textStyle = useMemo(() => ({ color }), [color]);
  const status = conceptStatus(n);
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        {/* 構想の行に操作ボタンは無い。空の置き場は題名を削るだけなので置かない。 */}
        {busy ? <ActivityIndicator size="small" /> : <Text style={textStyle}>{status}</Text>}
      </View>
    ),
    [busy, textStyle, status],
  );
  return (
    <SidebarRow
      id={`concept-${n.path}`}
      icon={CONCEPT_ICON[n.status]}
      label={conceptLabel(n)}
      onPress={press}
      trailing={trailing}
    />
  );
}

const styles = StyleSheet.create({
  trailing: { flexDirection: "row", alignItems: "center", gap: 4 },
  chevron: { fontSize: 11 },
  toggleHit: { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" },
});
