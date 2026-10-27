/**
 * 構想ノートの閲覧・編集画面(Obsidian 風。編集は既存ノートの本文だけ)。構想の行を押すと開く。
 *
 * 本文は live Vault から Paseo のサーバーが読む(`topos.notes.read`)。`[[リンク]]` は
 * `topos.notes.resolve-link` で行き先を引き、同じ画面で開き直す。壁打ちはここ(上のボタン)か、
 * 一覧の行の「…」メニューから始める(`topos.notes.open-concept-thread`)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, Linking } from "react-native";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { openConceptThreadRpc } from "../shared/notes.js";
import {
  NOTE_VIEW_SCREEN_ID,
  readNoteRpc,
  resolveNoteLinkRpc,
  saveNoteRpc,
} from "../shared/note-view.js";
import type { ReadNoteOutput } from "../shared/note-view.js";
import { parseMarkdown } from "../shared/markdown-lite.js";
import type { Block, Inline } from "../shared/markdown-lite.js";

type Colors = PluginHostProps["theme"]["colors"];

interface Props {
  theme: PluginHostProps["theme"];
  path: string | null;
  openScreen: (input: { screenId: string; params?: Record<string, string> }) => void;
  openAgent?: (input: { agentId: string; serverId?: string }) => void;
  serverId?: string;
}

export function ConceptNoteView({ theme, path, openScreen, openAgent, serverId }: Props) {
  const read = useRpc(readNoteRpc);
  const resolve = useRpc(resolveNoteLinkRpc);
  const save = useRpc(saveNoteRpc);
  const openThread = useRpc(openConceptThreadRpc);
  const [note, setNote] = useState<ReadNoteOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ current: string; version: string } | null>(null);
  const c = theme.colors;

  useEffect(() => {
    setNote(null);
    setError(null);
    setNotice(null);
    setEditing(false);
    setConflict(null);
    if (!path) {
      setError("ノートが指定されていません");
      return;
    }
    let live = true;
    read({ path })
      .then((r) => {
        if (!live) return null;
        if (r.ok) setNote(r);
        else setError(r.message ?? "開けません");
        return null;
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [path, read]);

  const onLink = useCallback(
    (target: string) => {
      if (!path) return;
      resolve({ from: path, target })
        .then((r) => {
          if (r.ok && r.path)
            openScreen({ screenId: NOTE_VIEW_SCREEN_ID, params: { path: r.path } });
          else setNotice(r.message ?? "リンク先を開けません");
          return null;
        })
        .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
    },
    [openScreen, path, resolve],
  );

  const onExternal = useCallback((href: string) => void Linking.openURL(href), []);

  const onThread = useCallback(() => {
    if (!path || busy) return;
    setBusy(true);
    openThread({ path })
      .then((r) => {
        if (r.ok && r.threadId && openAgent) openAgent({ agentId: r.threadId, serverId });
        else if (r.ok && r.threadId)
          openScreen({ screenId: "child-threads", params: { focusId: r.threadId } });
        else setNotice(r.message ?? "スレを作れません");
        return null;
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [busy, openAgent, openScreen, openThread, path, serverId]);

  const onEdit = useCallback(() => {
    if (!note) return;
    setDraft(note.raw);
    setConflict(null);
    setNotice(null);
    setEditing(true);
  }, [note]);

  const onCancel = useCallback(() => {
    setEditing(false);
    setConflict(null);
  }, []);

  /** 競合のとき: 自分の編集を捨てて、いま保存されている最新に差し替える。 */
  const onReload = useCallback(() => {
    if (!conflict) return;
    setDraft(conflict.current);
    setNote((n) => (n ? { ...n, raw: conflict.current, version: conflict.version } : n));
    setConflict(null);
  }, [conflict]);

  const onSave = useCallback(() => {
    if (!path || !note || saving) return;
    setSaving(true);
    setNotice(null);
    save({ path, text: draft, base: note.version })
      .then((r) => {
        if (r.status === "saved" || r.status === "unchanged") {
          // 本文・題名・状態は保存後のファイルから読み直す。
          setEditing(false);
          setConflict(null);
          setNotice(r.message);
          return read({ path }).then((n) => {
            if (n.ok) setNote(n);
            return null;
          });
        }
        if (r.status === "conflict") setConflict({ current: r.current, version: r.version });
        setNotice(r.message);
        return null;
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  }, [draft, note, path, read, save, saving]);

  const blocks = useMemo(() => (note ? parseMarkdown(note.body) : []), [note]);
  const s = useMemo(() => styles(c), [c]);

  return (
    <ScrollView style={s.root} contentContainerStyle={s.body}>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!note && !error ? <Text style={s.muted}>読み込み中…</Text> : null}
      {note ? (
        <>
          <Text style={s.title}>{note.title}</Text>
          <View style={s.metaRow}>
            <Text style={s.muted}>
              {note.rel}
              {note.status ? ` ・ ${note.status}` : ""}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="この構想を壁打ちする"
              disabled={busy}
              onPress={onThread}
              style={s.button}
            >
              <Text style={s.buttonText}>{busy ? "開いています…" : "壁打ちする"}</Text>
            </Pressable>
            {note.editable && !editing ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="このノートを編集する"
                onPress={onEdit}
                style={s.button}
              >
                <Text style={s.buttonText}>編集</Text>
              </Pressable>
            ) : null}
          </View>
          {!note.editable && note.editBlock ? <Text style={s.muted}>{note.editBlock}</Text> : null}
          {notice ? <Text style={s.error}>{notice}</Text> : null}
          {editing ? (
            <Editor
              s={s}
              draft={draft}
              onChange={setDraft}
              saving={saving}
              conflict={conflict !== null}
              onSave={onSave}
              onCancel={onCancel}
              onReload={onReload}
            />
          ) : (
            blocks.map((b) => (
              <BlockView key={b.id} block={b} s={s} onLink={onLink} onExternal={onExternal} />
            ))
          )}
          {note.truncated ? <Text style={s.muted}>(長いため途中までを表示しています)</Text> : null}
        </>
      ) : null}
    </ScrollView>
  );
}

type S = ReturnType<typeof styles>;

interface EditorProps {
  s: S;
  draft: string;
  onChange: (v: string) => void;
  saving: boolean;
  conflict: boolean;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
}

function Editor({ s, draft, onChange, saving, conflict, onSave, onCancel, onReload }: EditorProps) {
  return (
    <View style={s.editor}>
      {conflict ? (
        <Text style={s.error}>
          別の場所で変更されています。「最新に差し替える」と今の編集は捨てられます(下の文章は
          コピーしてから)。
        </Text>
      ) : null}
      <TextInput
        accessibilityLabel="ノートの本文"
        multiline
        value={draft}
        onChangeText={onChange}
        style={s.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={s.metaRow}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={s.button}>
          <Text style={s.buttonText}>キャンセル</Text>
        </Pressable>
        {conflict ? (
          <Pressable accessibilityRole="button" onPress={onReload} style={s.button}>
            <Text style={s.buttonText}>最新に差し替える</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="保存する"
            disabled={saving}
            onPress={onSave}
            style={s.button}
          >
            <Text style={s.buttonText}>{saving ? "保存中…" : "保存"}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

interface Handlers {
  s: S;
  onLink: (target: string) => void;
  onExternal: (href: string) => void;
}

function LinkText({
  label,
  value,
  style,
  onPress,
}: {
  label: string;
  value: string;
  style: object;
  onPress: (v: string) => void;
}) {
  const press = useCallback(() => onPress(value), [onPress, value]);
  return (
    <Text style={style} onPress={press}>
      {label}
    </Text>
  );
}

function InlineItem({ p, s, onLink, onExternal }: { p: Inline } & Handlers) {
  if (p.t === "bold") return <Text style={s.bold}>{p.v}</Text>;
  if (p.t === "italic") return <Text style={s.italic}>{p.v}</Text>;
  if (p.t === "code") return <Text style={s.code}>{p.v}</Text>;
  if (p.t === "wikilink")
    return <LinkText label={p.label} value={p.target} style={s.link} onPress={onLink} />;
  if (p.t === "link")
    return <LinkText label={p.label} value={p.href} style={s.link} onPress={onExternal} />;
  return <Text>{p.v}</Text>;
}

function InlineText({ parts, base, ...h }: { parts: Inline[]; base?: object } & Handlers) {
  return (
    <Text style={base ?? h.s.text}>
      {parts.map((p) => (
        <InlineItem key={p.id} p={p} {...h} />
      ))}
    </Text>
  );
}

function ListView({ block, ...h }: { block: Extract<Block, { t: "list" }> } & Handlers) {
  return (
    <View style={h.s.list}>
      {block.items.map((it) => (
        <View key={it.id} style={h.s.li[it.depth]}>
          <Text style={h.s.marker}>{it.marker}</Text>
          <View style={h.s.liBody}>
            <InlineText parts={it.inl} {...h} />
          </View>
        </View>
      ))}
    </View>
  );
}

function TableView({ block, ...h }: { block: Extract<Block, { t: "table" }> } & Handlers) {
  return (
    <View style={h.s.table}>
      {block.rows.map((row) => (
        <View key={row.id} style={row.head ? h.s.trHead : h.s.tr}>
          {row.cells.map((cell) => (
            <View key={cell.id} style={h.s.td}>
              <InlineText parts={cell.inl} {...h} base={row.head ? h.s.boldText : undefined} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function BlockView({ block: b, ...h }: { block: Block } & Handlers) {
  const { s } = h;
  if (b.t === "heading") {
    return <InlineText parts={b.inl} base={s.heading[Math.min(b.level, 3) - 1]} {...h} />;
  }
  if (b.t === "para") return <InlineText parts={b.inl} {...h} />;
  if (b.t === "quote")
    return (
      <View style={s.quote}>
        <InlineText parts={b.inl} {...h} />
      </View>
    );
  if (b.t === "code")
    return (
      <View style={s.codeBlock}>
        <Text style={s.codeText}>{b.v}</Text>
      </View>
    );
  if (b.t === "hr") return <View style={s.hr} />;
  if (b.t === "list") return <ListView block={b} {...h} />;
  return <TableView block={b} {...h} />;
}

function styles(c: Colors) {
  const text = { color: c.foreground, fontSize: 14, lineHeight: 22 } as const;
  const tr = { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border } as const;
  const heading = [
    { ...text, fontSize: 20, fontWeight: "700", marginTop: 10 },
    { ...text, fontSize: 17, fontWeight: "700", marginTop: 8 },
    { ...text, fontSize: 15, fontWeight: "700", marginTop: 6 },
  ] as const;
  return {
    root: { flex: 1, backgroundColor: c.surface0 },
    body: { padding: 16, gap: 10, maxWidth: 820, alignSelf: "center", width: "100%" },
    title: { color: c.foreground, fontSize: 22, fontWeight: "700" },
    muted: { color: c.foregroundMuted, fontSize: 12, flexShrink: 1 },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    error: { color: "#c0392b", fontSize: 13 },
    button: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    editor: { gap: 8 },
    input: {
      color: c.foreground,
      backgroundColor: c.surface1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      padding: 10,
      minHeight: 320,
      fontFamily: "Menlo",
      fontSize: 13,
      lineHeight: 20,
      textAlignVertical: "top",
    },
    buttonText: { color: c.foreground, fontSize: 13 },
    text,
    boldText: { ...text, fontWeight: "700" },
    bold: { fontWeight: "700" },
    italic: { fontStyle: "italic" },
    code: { fontFamily: "Menlo", backgroundColor: c.surface1, fontSize: 13 },
    link: { color: "#3b82f6", textDecorationLine: "underline" },
    heading,
    quote: { borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 10 },
    codeBlock: { backgroundColor: c.surface1, borderRadius: 6, padding: 10 },
    codeText: { color: c.foreground, fontFamily: "Menlo", fontSize: 12 },
    hr: { height: 1, backgroundColor: c.border, marginVertical: 6 },
    list: { gap: 4 },
    li: [0, 1, 2, 3, 4].map((d) => ({
      flexDirection: "row" as const,
      gap: 6,
      paddingLeft: d * 16,
    })),
    liBody: { flex: 1 },
    marker: { ...text, width: 18 },
    table: { borderWidth: 1, borderColor: c.border, borderRadius: 6 },
    tr,
    trHead: { ...tr, backgroundColor: c.surface1 },
    td: { flex: 1, padding: 6 },
  } as const;
}
