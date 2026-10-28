/**
 * ノートタブ: 共有ノートの一覧・閲覧(Markdown)・作成・編集・削除・履歴・過去の版の表示と復元・削除済み一覧。
 * 閲覧のみのメンバーには書き込みの操作を出さない。権限・保存・履歴の仕組みは Topos 側。
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { shortTime } from "../../shared/shared-projects.js";
import {
  opLabel,
  parseNote,
  parseNoteList,
  parseVersionBody,
  parseVersions,
  type Note,
  type NoteSummary,
  type NoteVersion,
  type NoteVersionBody,
} from "../../shared/shared-projects-api.js";
import { Markdown } from "./Markdown.js";
import type { ProjectCtx } from "./types.js";
import { Banner, Btn, nameOfUser, type S } from "./ui.js";

type Mode =
  | { kind: "list" }
  | { kind: "deleted" }
  | { kind: "view"; nid: string }
  | { kind: "edit"; nid: string }
  | { kind: "new" }
  | { kind: "history"; nid: string; title: string }
  | { kind: "version"; nid: string; title: string; v: number };

const TITLE_MAX = 200;
const BODY_MAX = 100_000;

interface Loaded<T> {
  loading: boolean;
  error: string;
  data: T | null;
}

/** 取得の共通形。key が変わったら取り直す。 */
function useLoad<T>(
  ctx: ProjectCtx,
  op: "notes" | "notesDeleted" | "note" | "noteHistory" | "noteVersion",
  params: { nid?: string; v?: number; skip?: boolean },
  parse: (raw: unknown) => T | null,
): Loaded<T> & { reload: () => void } {
  const { call, id } = ctx;
  const [state, setState] = useState<Loaded<T>>({ loading: true, error: "", data: null });
  const [tick, setTick] = useState(0);
  const { nid, v, skip } = params;
  useEffect(() => {
    if (skip) {
      setState({ loading: false, error: "", data: null });
      return undefined;
    }
    let alive = true;
    setState((cur) => ({ ...cur, loading: true, error: "" }));
    void call(op, { id, ...(nid ? { nid } : {}), ...(v !== undefined ? { v } : {}) }).then((r) => {
      if (!alive) return null;
      if (!r.ok) {
        setState({ loading: false, error: r.message, data: null });
        return null;
      }
      const data = parse(r.data);
      setState({
        loading: false,
        error: data === null ? "Topos の応答を読めませんでした" : "",
        data,
      });
      return null;
    });
    return () => {
      alive = false;
    };
  }, [call, id, op, nid, v, skip, parse, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

function Status({ s, st }: { s: S; st: Loaded<unknown> }) {
  return (
    <>
      {st.loading ? <Text style={s.muted}>読み込み中…</Text> : null}
      <Banner s={s} text={st.error} error />
    </>
  );
}

function NoteRow({ s, note, onOpen }: { s: S; note: NoteSummary; onOpen: (nid: string) => void }) {
  const press = useCallback(() => onOpen(note.id), [onOpen, note.id]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note.title}
      onPress={press}
      style={s.cardRow}
    >
      <Text style={s.h2}>{note.overview ? `${note.title}(プロジェクトの概要)` : note.title}</Text>
      <Text
        style={s.muted}
      >{`${note.author ? `${note.author} ・ ` : ""}${shortTime(note.updatedAt)}`}</Text>
    </Pressable>
  );
}

// ── 一覧 ─────────────────────────────────────────────────────────────

function List({ ctx, deleted, go }: { ctx: ProjectCtx; deleted: boolean; go: (m: Mode) => void }) {
  const { s, writable } = ctx;
  const st = useLoad(ctx, deleted ? "notesDeleted" : "notes", {}, parseNoteList);
  const open = useCallback(
    (nid: string) => {
      const title = st.data?.find((n) => n.id === nid)?.title ?? "";
      go(deleted ? { kind: "history", nid, title } : { kind: "view", nid });
    },
    [go, deleted, st.data],
  );
  const toNew = useCallback(() => go({ kind: "new" }), [go]);
  const toDeleted = useCallback(() => go({ kind: "deleted" }), [go]);
  const toList = useCallback(() => go({ kind: "list" }), [go]);
  const notes = st.data ?? [];
  return (
    <View style={s.page}>
      <View style={s.rowBetween}>
        <Text style={s.h2}>{deleted ? "削除したノート" : "共有ノート"}</Text>
        <View style={s.rowWrap}>
          {deleted ? (
            <Btn s={s} label="ノート一覧へ" onPress={toList} />
          ) : (
            <>
              {writable ? (
                <Btn s={s} label="＋ 新しいノート" tone="primary" onPress={toNew} />
              ) : null}
              <Btn s={s} label="削除したノート" onPress={toDeleted} />
            </>
          )}
        </View>
      </View>
      {deleted ? (
        <Text style={s.muted}>押すと履歴が開きます。履歴から過去の版を復元できます。</Text>
      ) : null}
      <Status s={s} st={st} />
      {!st.loading && !st.error && notes.length === 0 ? (
        <Text style={s.muted}>
          {deleted ? "削除したノートはありません" : "まだノートはありません"}
        </Text>
      ) : null}
      {notes.map((n) => (
        <NoteRow key={n.id} s={s} note={n} onOpen={open} />
      ))}
    </View>
  );
}

// ── 閲覧 ─────────────────────────────────────────────────────────────

function View_({ ctx, nid, go }: { ctx: ProjectCtx; nid: string; go: (m: Mode) => void }) {
  const { s, colors, call, id, writable } = ctx;
  const st = useLoad(ctx, "note", { nid }, parseNote);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const note: Note | null = st.data;
  const toList = useCallback(() => go({ kind: "list" }), [go]);
  const toEdit = useCallback(() => go({ kind: "edit", nid }), [go, nid]);
  const toHistory = useCallback(
    () => go({ kind: "history", nid, title: note?.title ?? "" }),
    [go, nid, note?.title],
  );
  const ask = useCallback(() => setConfirm(true), []);
  const cancel = useCallback(() => setConfirm(false), []);
  const remove = useCallback(() => {
    void call("noteDelete", { id, nid }).then((r) => {
      if (r.ok) go({ kind: "list" });
      else {
        setConfirm(false);
        setNotice(r.message);
      }
      return null;
    });
  }, [call, id, nid, go]);
  return (
    <View style={s.page}>
      <View style={s.rowWrap}>
        <Btn s={s} label="一覧へ" onPress={toList} />
        <Btn s={s} label="履歴" onPress={toHistory} />
        {writable ? <Btn s={s} label="編集" onPress={toEdit} /> : null}
        {writable && !confirm ? <Btn s={s} label="削除" tone="danger" onPress={ask} /> : null}
      </View>
      {confirm ? (
        <View style={s.card}>
          <Text style={s.text}>このノートを削除しますか?(履歴から復元できます)</Text>
          <View style={s.rowWrap}>
            <Btn s={s} label="削除する" tone="danger" onPress={remove} />
            <Btn s={s} label="やめる" onPress={cancel} />
          </View>
        </View>
      ) : null}
      <Status s={s} st={st} />
      <Banner s={s} text={notice} error />
      {note ? (
        <>
          <Text style={s.title}>{note.title}</Text>
          <Text
            style={s.muted}
          >{`${note.author ? `${note.author} ・ ` : ""}${shortTime(note.updatedAt)}`}</Text>
          <Markdown source={note.body} colors={colors} />
        </>
      ) : null}
    </View>
  );
}

// ── 作成・編集 ───────────────────────────────────────────────────────

function Edit({ ctx, nid, go }: { ctx: ProjectCtx; nid: string | null; go: (m: Mode) => void }) {
  const { s, colors, call, id } = ctx;
  const st = useLoad(ctx, "note", nid ? { nid } : { skip: true }, parseNote);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (nid && st.data && loadedFor !== nid) {
      setTitle(st.data.title);
      setBody(st.data.body);
      setLoadedFor(nid);
    }
  }, [nid, st.data, loadedFor]);

  const back = useCallback(() => go(nid ? { kind: "view", nid } : { kind: "list" }), [go, nid]);
  const save = useCallback(() => {
    if (saving || !title.trim()) return;
    setSaving(true);
    setNotice("");
    const payload = { title: title.trim(), body };
    const req = nid
      ? call("noteUpdate", { id, nid, body: payload })
      : call("noteCreate", { id, body: payload });
    void req.then((r) => {
      setSaving(false);
      if (!r.ok) {
        setNotice(r.message);
        return null;
      }
      const saved = parseNote(r.data);
      go(saved ? { kind: "view", nid: saved.id } : { kind: "list" });
      return null;
    });
  }, [saving, title, body, nid, call, id, go]);

  return (
    <View style={s.page}>
      <Text style={s.h2}>{nid ? "ノートを編集" : "新しいノート"}</Text>
      {nid ? <Status s={s} st={st} /> : null}
      <TextInput
        style={s.input}
        value={title}
        onChangeText={setTitle}
        placeholder="題名"
        placeholderTextColor={colors.foregroundMuted}
        maxLength={TITLE_MAX}
      />
      <TextInput
        style={s.inputNote}
        value={body}
        onChangeText={setBody}
        placeholder="本文(Markdown)"
        placeholderTextColor={colors.foregroundMuted}
        multiline
        maxLength={BODY_MAX}
      />
      <Banner s={s} text={notice} error />
      <View style={s.rowWrap}>
        <Btn
          s={s}
          label={saving ? "保存中…" : "保存"}
          tone="primary"
          onPress={save}
          disabled={saving || !title.trim()}
        />
        <Btn s={s} label="やめる" onPress={back} />
      </View>
    </View>
  );
}

// ── 履歴 ─────────────────────────────────────────────────────────────

function VersionRow({
  s,
  ver,
  who,
  onOpen,
}: {
  s: S;
  ver: NoteVersion;
  who: string;
  onOpen: (v: string) => void;
}) {
  const press = useCallback(() => onOpen(String(ver.v)), [onOpen, ver.v]);
  const from = ver.restoredFrom !== null ? `(v${ver.restoredFrom}から)` : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`版${ver.v}を開く`}
      onPress={press}
      style={s.cardRow}
    >
      <Text style={s.h2}>{`v${ver.v} ・ ${opLabel(ver.op)}${from}`}</Text>
      <Text style={s.muted}>
        {`${who} ・ ${shortTime(ver.ts)} ・ +${ver.added} / -${ver.removed}`}
      </Text>
    </Pressable>
  );
}

function History({
  ctx,
  nid,
  title,
  go,
}: {
  ctx: ProjectCtx;
  nid: string;
  title: string;
  go: (m: Mode) => void;
}) {
  const { s, detail } = ctx;
  const st = useLoad(ctx, "noteHistory", { nid }, parseVersions);
  const back = useCallback(() => go({ kind: "view", nid }), [go, nid]);
  const toList = useCallback(() => go({ kind: "list" }), [go]);
  const open = useCallback(
    (v: string) => go({ kind: "version", nid, title, v: Number(v) }),
    [go, nid, title],
  );
  const versions = [...(st.data ?? [])].sort((a, b) => b.v - a.v);
  const members = detail?.members ?? [];
  return (
    <View style={s.page}>
      <View style={s.rowWrap}>
        <Btn s={s} label="一覧へ" onPress={toList} />
        <Btn s={s} label="ノートへ" onPress={back} />
      </View>
      <Text style={s.h2}>{title ? `履歴: ${title}` : "履歴"}</Text>
      <Status s={s} st={st} />
      {!st.loading && !st.error && versions.length === 0 ? (
        <Text style={s.muted}>履歴はありません</Text>
      ) : null}
      {versions.map((v) => (
        <VersionRow key={v.v} s={s} ver={v} who={nameOfUser(v.actor, members)} onOpen={open} />
      ))}
    </View>
  );
}

function Version({
  ctx,
  nid,
  title,
  v,
  go,
}: {
  ctx: ProjectCtx;
  nid: string;
  title: string;
  v: number;
  go: (m: Mode) => void;
}) {
  const { s, colors, call, id, writable } = ctx;
  const st = useLoad(ctx, "noteVersion", { nid, v }, parseVersionBody);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const body: NoteVersionBody | null = st.data;
  const back = useCallback(() => go({ kind: "history", nid, title }), [go, nid, title]);
  const ask = useCallback(() => setConfirm(true), []);
  const cancel = useCallback(() => setConfirm(false), []);
  const restore = useCallback(() => {
    void call("noteRestore", { id, nid, v }).then((r) => {
      if (r.ok) go({ kind: "view", nid });
      else {
        setConfirm(false);
        setNotice(r.message);
      }
      return null;
    });
  }, [call, id, nid, v, go]);
  return (
    <View style={s.page}>
      <View style={s.rowWrap}>
        <Btn s={s} label="履歴へ" onPress={back} />
        {writable && !confirm ? <Btn s={s} label="この版に戻す" onPress={ask} /> : null}
      </View>
      {confirm ? (
        <View style={s.card}>
          <Text style={s.text}>{`v${v} の内容に戻しますか?(現在の内容は履歴に残ります)`}</Text>
          <View style={s.rowWrap}>
            <Btn s={s} label="戻す" tone="primary" onPress={restore} />
            <Btn s={s} label="やめる" onPress={cancel} />
          </View>
        </View>
      ) : null}
      <Status s={s} st={st} />
      <Banner s={s} text={notice} error />
      {body ? (
        <>
          <Text style={s.title}>{body.title || title}</Text>
          <Text style={s.muted}>{`v${v} の内容`}</Text>
          <Markdown source={body.body} colors={colors} />
        </>
      ) : null}
    </View>
  );
}

// ── ノートタブ ───────────────────────────────────────────────────────

export function NotesPane({ ctx }: { ctx: ProjectCtx }) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // プロジェクトが変わったら一覧へ戻す
  useEffect(() => setMode({ kind: "list" }), [ctx.id]);
  if (ctx.limited)
    return (
      <View style={ctx.s.page}>
        <Banner
          s={ctx.s}
          text="この鍵では共有ノートは使えません。フル機能用の鍵(projects_full)に切り替えてください"
        />
      </View>
    );
  switch (mode.kind) {
    case "list":
      return <List ctx={ctx} deleted={false} go={setMode} />;
    case "deleted":
      return <List ctx={ctx} deleted go={setMode} />;
    case "view":
      return <View_ ctx={ctx} nid={mode.nid} go={setMode} />;
    case "edit":
      return <Edit ctx={ctx} nid={mode.nid} go={setMode} />;
    case "new":
      return <Edit ctx={ctx} nid={null} go={setMode} />;
    case "history":
      return <History ctx={ctx} nid={mode.nid} title={mode.title} go={setMode} />;
    default:
      return <Version ctx={ctx} nid={mode.nid} title={mode.title} v={mode.v} go={setMode} />;
  }
}
