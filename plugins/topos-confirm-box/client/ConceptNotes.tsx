/**
 * サイドバー二段の**下段**(進行中の構想)と、**上段の実装ノートの重ね合わせ**。
 *
 * - status の正は Vault ノートの frontmatter(標準_サイドバーの表示ルール)。ここでは書かない。
 * - 下段: 構想/壁打ち中の構想ノート。行は「題名 — 1行の結論」。押すとその構想の**スレ**を開く
 *   (ノートの `thread` / `threads` に書かれた、実在するスレ)。スレがまだ無いノートは
 *   Obsidian でノートを開く(スレの自動作成はワークスペース・モデルを決める必要があるため、
 *   夜間の実装では行わない=ユーザー判断待ち)。
 * - 上段: 実装ノート(status=実装中/判断待ち/確認待ち)。子スレ一覧の行に status と題名を重ねる。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { notesSidebarRpc } from "../shared/notes.js";
import type { NoteStatus, SidebarNote } from "../shared/notes.js";
import { lowerTierNotes } from "../shared/sidebar-rows.js";

const POLL_MS = 60_000;
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
}

/** ノート一覧を取得する(サイドバー項目ごとに1回)。 */
export function useSidebarNotes(): SidebarNotesState {
  const list = useRpc(notesSidebarRpc);
  const [notes, setNotes] = useState<SidebarNote[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      list({})
        .then((r) => {
          if (!alive) return null;
          setNotes(r.notes);
          setError(r.error ?? (r.truncated ? "ノートの走査が途中で打ち切られました" : null));
          return null;
        })
        .catch(() => alive && setError("ノートを取得できません"));
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [list]);

  // 実装ノートをスレIDで引く。ノートは1スレに1枚(検収単位と1対1)なので、解決済みIDだけを張る
  // (候補を全部張ると同じノートが複数行に重なる)。同じスレに複数枚あれば新しい順の先頭。
  const implByThread = useMemo(() => {
    const map = new Map<string, SidebarNote>();
    for (const n of notes) {
      if (n.kind === "implementation" && n.threadId && !map.has(n.threadId)) {
        map.set(n.threadId, n);
      }
    }
    return map;
  }, [notes]);
  return { notes, error, implByThread };
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

function oneLine(s: string, max = 56): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** ノートを Obsidian で開く(スレがまだ無い構想の逃げ道)。Vault 名は既定の Obsidian_Vault。 */
export function obsidianUrl(notePath: string): string {
  const name = /([^/\\]+)\.md$/.exec(notePath)?.[1] ?? notePath;
  return `obsidian://open?vault=Obsidian_Vault&file=${encodeURIComponent(name)}`;
}

function conceptLabel(n: SidebarNote): string {
  return n.conclusion ? `${n.title} — ${oneLine(n.conclusion)}` : n.title;
}

function conceptStatus(n: SidebarNote): string {
  return n.threadId ? n.status : `${n.status}(スレ未作成)`;
}

export function ConceptNotesSection({
  notes,
  error,
  openAgent,
  serverId,
  openScreen,
  statusColor,
}: {
  notes: readonly SidebarNote[];
  error: string | null;
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId: string;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
  /** 行右端の状態文字の色(WCAG AA を満たすものを親が選ぶ)。 */
  statusColor: string;
}) {
  const [open, setOpen] = useState(() => !readCollapsed());
  const [busy, setBusy] = useState<string | null>(null);

  const concepts = useMemo(() => lowerTierNotes(notes), [notes]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      writeCollapsed(v);
      return !v;
    });
  }, []);

  const press = useCallback(
    (n: SidebarNote) => {
      if (n.threadId && openAgent) {
        openAgent({ agentId: n.threadId, serverId });
        return;
      }
      if (n.threadId) {
        openScreen({ screenId: "child-threads", params: { focusId: n.threadId } });
        return;
      }
      // スレ未作成: ノート自体を開く(Obsidian が無ければ何も起きない=行は残る)。
      setBusy(n.path);
      void Linking.openURL(obsidianUrl(n.path))
        .catch(() => {})
        .finally(() => setBusy((cur) => (cur === n.path ? null : cur)));
    },
    [openAgent, openScreen, serverId],
  );

  const headerLabel =
    error && concepts.length === 0 ? "進行中の構想(取得失敗)" : `進行中の構想 ${concepts.length}件`;

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
      <SidebarRow
        id="concept-notes-header"
        icon="Lightbulb"
        label={headerLabel}
        onPress={toggle}
        trailing={headerTrailing}
      />
      {open
        ? concepts.map((n) => (
            <ConceptRow
              key={n.path}
              note={n}
              busy={busy === n.path}
              onPress={press}
              color={statusColor}
            />
          ))
        : null}
      {open && concepts.length === 0 ? (
        <SidebarRow
          id="concept-notes-empty"
          icon="Lightbulb"
          label="進行中の構想はありません"
          onPress={toggle}
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
    () => (busy ? <ActivityIndicator size="small" /> : <Text style={textStyle}>{status}</Text>),
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
