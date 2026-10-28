/**
 * 概要・メンバータブ: 概要ノートの表示、名前と説明の変更、メンバー(招待・除名・脱退)、アーカイブ。
 * 変更してよい人の判定は Topos 側(名前・説明は閲覧のみ以外、招待と除名は作成者)。画面は出し分けと、拒否理由の表示だけ。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import {
  parseCandidates,
  parseNote,
  type Candidate,
  type Member,
  type Note,
} from "../../shared/shared-projects-api.js";
import { emitProjectsChanged, type ApiResult } from "./api.js";
import { Markdown } from "./Markdown.js";
import type { ProjectCtx } from "./types.js";
import { Banner, Btn, Chip } from "./ui.js";

const NAME_MAX = 80;
const DESC_MAX = 200;

// ── 概要 ─────────────────────────────────────────────────────────────

function Overview({ ctx }: { ctx: ProjectCtx }) {
  const { s, colors, call, id } = ctx;
  const [note, setNote] = useState<Note | null>(null);
  const [state, setState] = useState<"loading" | "none" | "ok" | "error">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setState("loading");
    void (async () => {
      const ov = await call("overview", { id });
      if (!alive) return;
      if (!ov.ok) {
        setState("error");
        setError(ov.message);
        return;
      }
      const nid = (ov.data as { note_id?: unknown } | null)?.note_id;
      if (typeof nid !== "string") {
        setState("none");
        return;
      }
      const n = await call("note", { id, nid });
      if (!alive) return;
      if (!n.ok) {
        setState("error");
        setError(n.message);
        return;
      }
      setNote(parseNote(n.data));
      setState("ok");
    })();
    return () => {
      alive = false;
    };
  }, [call, id, ctx.detail?.overviewPending]);
  return (
    <View style={s.card}>
      <Text style={s.h2}>プロジェクトの概要</Text>
      {state === "loading" ? <Text style={s.muted}>読み込み中…</Text> : null}
      {state === "none" ? (
        <Text style={s.muted}>
          {ctx.detail?.overviewPending
            ? "スレッドでAIの質問に答えてください。答えが揃うと概要ができます"
            : "まだ概要はありません"}
        </Text>
      ) : null}
      <Banner s={s} text={state === "error" ? error : ""} error />
      {note ? <Markdown source={note.body} colors={colors} /> : null}
    </View>
  );
}

// ── 名前・説明 ───────────────────────────────────────────────────────

function FieldEdit({
  ctx,
  label,
  value,
  op,
  field,
  max,
  multiline,
  editable,
}: {
  ctx: ProjectCtx;
  label: string;
  value: string;
  op: "rename" | "description";
  field: "name" | "description";
  max: number;
  multiline: boolean;
  editable: boolean;
}) {
  const { s, colors, call, id } = ctx;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const start = useCallback(() => {
    setDraft(value);
    setEditing(true);
    setError("");
  }, [value]);
  const cancel = useCallback(() => setEditing(false), []);
  const save = useCallback(() => {
    setSaving(true);
    setError("");
    void call(op, { id, body: { [field]: draft.trim() } }).then(async (r) => {
      setSaving(false);
      if (!r.ok) {
        setError(r.message);
        return null;
      }
      setEditing(false);
      await ctx.reloadDetail();
      emitProjectsChanged();
      return null;
    });
  }, [call, op, id, field, draft, ctx]);
  return (
    <View style={s.card}>
      <Text style={s.label}>{label}</Text>
      {editing ? (
        <>
          <TextInput
            style={multiline ? s.inputMulti : s.input}
            value={draft}
            onChangeText={setDraft}
            placeholderTextColor={colors.foregroundMuted}
            multiline={multiline}
            maxLength={max}
          />
          <Banner s={s} text={error} error />
          <View style={s.rowWrap}>
            <Btn
              s={s}
              label={saving ? "保存中…" : "保存"}
              tone="primary"
              onPress={save}
              disabled={saving}
            />
            <Btn s={s} label="やめる" onPress={cancel} />
          </View>
        </>
      ) : (
        <View style={s.rowBetween}>
          <Text style={s.text} selectable>
            {value || "(未設定)"}
          </Text>
          {editable ? <Btn s={s} label="変更" onPress={start} /> : null}
        </View>
      )}
    </View>
  );
}

// ── メンバー ─────────────────────────────────────────────────────────

function roleLabel(m: Member): string {
  if (m.isCreator) return "作成者";
  return m.role === "viewer" ? "閲覧のみ" : "メンバー";
}

function MemberRow({
  ctx,
  m,
  onRemove,
}: {
  ctx: ProjectCtx;
  m: Member;
  onRemove: (uid: string) => void;
}) {
  const { s, creator, me } = ctx;
  return (
    <View style={s.cardRow}>
      <View style={s.rowBetween}>
        <View style={s.grow}>
          <Text style={s.text}>
            {m.userId === me && !m.name.includes("あなた") ? `${m.name}(あなた)` : m.name}
          </Text>
          <Text style={s.muted}>{roleLabel(m)}</Text>
        </View>
        {creator && !m.isCreator && m.userId !== me ? (
          <Btn
            s={s}
            label="除名"
            tone="danger"
            onPress={onRemove}
            value={m.userId}
            a11y={`${m.name}を除名`}
          />
        ) : null}
      </View>
    </View>
  );
}

function Members({ ctx }: { ctx: ProjectCtx }) {
  const { s, call, id, detail, creator, me, limited } = ctx;
  const members = useMemo(() => detail?.members ?? [], [detail]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [removing, setRemoving] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!creator || limited) return undefined;
    let alive = true;
    void call("candidates").then((r) => {
      if (alive && r.ok) setCandidates(parseCandidates(r.data));
      return null;
    });
    return () => {
      alive = false;
    };
  }, [call, creator, limited]);

  const invitable = useMemo(
    () => candidates.filter((c) => !members.some((m) => m.userId === c.userId)),
    [candidates, members],
  );

  /** 操作の結果を画面に反映する(成功: 詳細と一覧を取り直す / 失敗: 理由を出す)。 */
  const settle = useCallback(
    async (pending: Promise<ApiResult>, okMessage: string) => {
      const r = await pending;
      setRemoving("");
      setLeaving(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setNotice(okMessage);
      setError("");
      await ctx.reloadDetail();
      emitProjectsChanged();
    },
    [ctx],
  );

  const invite = useCallback(
    (uid: string) => void settle(call("invite", { id, body: { user_id: uid } }), "招待しました"),
    [call, id, settle],
  );
  const remove = useCallback(
    (copies: string) =>
      void settle(
        call("removeMember", {
          id,
          uid: removing,
          query: copies === "withdraw" ? {} : { withdraw_copies: "false" },
        }),
        "除名しました",
      ),
    [call, id, removing, settle],
  );
  const leave = useCallback(
    (copies: string) =>
      void settle(
        call("removeMember", {
          id,
          uid: me,
          query: copies === "delete" ? { delete_copies: "true" } : {},
        }),
        "脱退しました",
      ),
    [call, id, me, settle],
  );
  const askLeave = useCallback(() => setLeaving(true), []);
  const cancel = useCallback(() => {
    setLeaving(false);
    setRemoving("");
  }, []);
  const ask = useCallback((uid: string) => setRemoving(uid), []);
  const removingName = members.find((m) => m.userId === removing)?.name ?? removing;

  return (
    <View style={s.card}>
      <Text style={s.h2}>{`メンバー(${members.length}人)`}</Text>
      {members.map((m) => (
        <MemberRow key={m.userId} ctx={ctx} m={m} onRemove={ask} />
      ))}
      {removing ? (
        <View style={s.card}>
          <Text style={s.text}>{`${removingName} さんを除名しますか?`}</Text>
          <View style={s.rowWrap}>
            <Btn
              s={s}
              label="除名して共有コピーも取り下げる"
              tone="danger"
              onPress={remove}
              value="withdraw"
            />
            <Btn s={s} label="除名のみ(コピーは残す)" onPress={remove} value="keep" />
            <Btn s={s} label="やめる" onPress={cancel} />
          </View>
        </View>
      ) : null}
      {invitable.length > 0 ? (
        <>
          <Text style={s.label}>招待する</Text>
          <View style={s.rowWrap}>
            {invitable.map((c) => (
              <Chip
                key={c.userId}
                s={s}
                label={`＋ ${c.name}`}
                on={false}
                onPress={invite}
                value={c.userId}
              />
            ))}
          </View>
        </>
      ) : null}
      {leaving ? (
        <View style={s.card}>
          <Text style={s.text}>このプロジェクトから脱退しますか?</Text>
          <View style={s.rowWrap}>
            <Btn s={s} label="脱退する" tone="danger" onPress={leave} value="keep" />
            <Btn
              s={s}
              label="脱退して自分の共有コピーも取り下げる"
              tone="danger"
              onPress={leave}
              value="delete"
            />
            <Btn s={s} label="やめる" onPress={cancel} />
          </View>
        </View>
      ) : (
        <View style={s.rowWrap}>
          <Btn s={s} label="脱退する" onPress={askLeave} />
        </View>
      )}
      <Banner s={s} text={notice} />
      <Banner s={s} text={error} error />
    </View>
  );
}

// ── アーカイブ ───────────────────────────────────────────────────────

function Archive({ ctx }: { ctx: ProjectCtx }) {
  const { s, call, id } = ctx;
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const ask = useCallback(() => setAsking(true), []);
  const cancel = useCallback(() => setAsking(false), []);
  const archive = useCallback(() => {
    setAsking(false);
    void call("archive", { id }).then((r) => {
      if (r.ok) {
        setNotice("アーカイブしました。サイドバーの「アーカイブ済み」から戻せます");
        setError("");
        emitProjectsChanged();
      } else setError(r.message);
      return null;
    });
  }, [call, id]);
  return (
    <View style={s.card}>
      <Text style={s.h2}>アーカイブ</Text>
      <Text style={s.muted}>
        自分の一覧から外します(他のメンバーには影響しません)。いつでも戻せます。
      </Text>
      {asking ? (
        <View style={s.card}>
          <Text style={s.text}>このプロジェクトをアーカイブしますか?</Text>
          <View style={s.rowWrap}>
            <Btn s={s} label="アーカイブする" tone="danger" onPress={archive} />
            <Btn s={s} label="やめる" onPress={cancel} />
          </View>
        </View>
      ) : (
        <View style={s.rowWrap}>
          <Btn s={s} label="アーカイブ" onPress={ask} />
        </View>
      )}
      <Banner s={s} text={notice} />
      <Banner s={s} text={error} error />
    </View>
  );
}

export function InfoPane({ ctx }: { ctx: ProjectCtx }) {
  const { s, detail, writable, limited } = ctx;
  const editable = writable && !limited;
  return (
    <View style={s.page}>
      {limited ? (
        <Banner
          s={s}
          text="この鍵では名前・説明・メンバーの変更や概要の表示は使えません。フル機能用の鍵(projects_full)に切り替えてください"
        />
      ) : (
        <Overview ctx={ctx} />
      )}
      <FieldEdit
        ctx={ctx}
        label="名前"
        value={detail?.name ?? ""}
        op="rename"
        field="name"
        max={NAME_MAX}
        multiline={false}
        editable={editable}
      />
      <FieldEdit
        ctx={ctx}
        label="説明"
        value={detail?.description ?? ""}
        op="description"
        field="description"
        max={DESC_MAX}
        multiline
        editable={editable}
      />
      <Members ctx={ctx} />
      {limited ? null : <Archive ctx={ctx} />}
    </View>
  );
}
