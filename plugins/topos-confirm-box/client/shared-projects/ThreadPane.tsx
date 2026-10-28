/**
 * スレッドタブ: 投稿の一覧(AIの返信はMarkdown、@名前は強調、添付は縮小表示)と投稿欄。
 * 概要の聞き取り中は、作成者に「終了して作成」を出す。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { shortTime } from "../../shared/shared-projects.js";
import { splitMentions, type ChatMessage, type Member } from "../../shared/shared-projects-api.js";
import { emitProjectsChanged, type CallApi } from "./api.js";
import { AttachmentView } from "./Attachments.js";
import { CatchupBox } from "./CatchupBox.js";
import { Composer } from "./Composer.js";
import { Markdown } from "./Markdown.js";
import type { ProjectCtx } from "./types.js";
import { Banner, Btn, type Colors, type S } from "./ui.js";
import { useThread } from "./useThread.js";

interface ItemProps {
  s: S;
  colors: Colors;
  call: CallApi;
  projectId: string;
  m: ChatMessage;
  mentionNames: readonly string[];
  onZoom: (url: string) => void;
}

function MentionText({ s, text, names }: { s: S; text: string; names: readonly string[] }) {
  const parts = useMemo(() => splitMentions(text, names), [text, names]);
  return (
    <Text style={s.text} selectable>
      {parts.map((p) => (
        <Text key={p.id} style={p.mention ? s.mention : undefined}>
          {p.text}
        </Text>
      ))}
    </Text>
  );
}

function headline(m: ChatMessage): string {
  let to = "";
  if (m.toNames.length > 0) to = ` → ${m.toNames.join("・")}`;
  else if (!m.ai) to = " → 全員";
  return `${m.author}${to} ・ ${shortTime(m.ts)}`;
}

function bubbleOf(s: S, m: ChatMessage) {
  if (m.ai) return s.bubbleAi;
  return m.mine ? s.bubbleMine : s.bubbleOther;
}

function MessageBody({
  s,
  colors,
  m,
  mentionNames,
}: Pick<ItemProps, "s" | "colors" | "m" | "mentionNames">) {
  if (!m.text) return null;
  if (m.ai) return <Markdown source={m.text} colors={colors} />;
  return <MentionText s={s} text={m.text} names={mentionNames} />;
}

const MessageItem = memo(function MessageItem({
  s,
  colors,
  call,
  projectId,
  m,
  mentionNames,
  onZoom,
}: ItemProps) {
  if (m.system)
    return (
      <Text style={s.muted} selectable>
        {m.text}
      </Text>
    );
  return (
    <View style={bubbleOf(s, m)}>
      <Text style={s.msgHead}>{headline(m)}</Text>
      <MessageBody s={s} colors={colors} m={m} mentionNames={mentionNames} />
      {m.attachments.length > 0 ? (
        <View style={s.rowWrap}>
          {m.attachments.map((a) => (
            <AttachmentView
              key={a.id}
              s={s}
              call={call}
              projectId={projectId}
              att={a}
              onZoom={onZoom}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

function Zoom({ s, url, onClose }: { s: S; url: string; onClose: (v: string) => void }) {
  const source = useMemo(() => ({ uri: url }), [url]);
  const close = useCallback(() => onClose(""), [onClose]);
  if (!url) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="拡大を閉じる"
      onPress={close}
      style={s.overlay}
    >
      <Image source={source} style={s.zoomImg} resizeMode="contain" />
    </Pressable>
  );
}

function mentionNamesOf(members: readonly Member[]): string[] {
  return ["AI", ...members.map((m) => m.name)];
}

export function ThreadPane({
  ctx,
  thread,
}: {
  ctx: ProjectCtx;
  thread: ReturnType<typeof useThread>;
}) {
  const { s, colors, call, id, detail, writable, creator, limited } = ctx;
  const [zoom, setZoom] = useState("");
  const [finishAsk, setFinishAsk] = useState(false);
  const [finishError, setFinishError] = useState("");
  const scroller = useRef<ScrollView>(null);
  const messages = thread.view?.messages ?? [];
  const count = messages.length;
  const mentionNames = useMemo(() => mentionNamesOf(detail?.members ?? []), [detail]);

  useEffect(() => {
    const t = setTimeout(() => scroller.current?.scrollToEnd({ animated: false }), 30);
    return () => clearTimeout(t);
  }, [count, id]);

  const showFinish = useCallback(() => setFinishAsk(true), []);
  const finish = useCallback(() => {
    void (async () => {
      setFinishError("");
      const r = await call("overviewFinish", { id });
      if (!r.ok) {
        setFinishError(r.message);
        return;
      }
      setFinishAsk(false);
      await ctx.reloadDetail();
      await thread.reload();
      emitProjectsChanged();
    })();
  }, [call, id, ctx, thread]);
  const cancelFinish = useCallback(() => setFinishAsk(false), []);

  const pending = detail?.overviewPending === true;
  const canFinish = pending && creator && !limited;
  const empty = !thread.loading && count === 0 && !thread.error;

  return (
    <View style={s.fill}>
      <ScrollView ref={scroller} contentContainerStyle={s.msgList}>
        {thread.openedAtSeq !== null &&
        !limited &&
        thread.openedAtSeq < (thread.view?.latestSeq ?? 0) ? (
          <CatchupBox ctx={ctx} sinceSeq={thread.openedAtSeq} />
        ) : null}
        {thread.loading ? <Text style={s.muted}>読み込み中…</Text> : null}
        <Banner s={s} text={thread.error} error />
        {empty ? <Text style={s.muted}>まだ投稿はありません</Text> : null}
        {messages.map((m) => (
          <MessageItem
            key={m.seq}
            s={s}
            colors={colors}
            call={call}
            projectId={id}
            m={m}
            mentionNames={mentionNames}
            onZoom={setZoom}
          />
        ))}
        {canFinish ? (
          <View style={s.card}>
            <Text style={s.text}>
              AIがプロジェクトの目的を聞いている途中です。答えが揃ったら、聞き取りを終えて概要ノートを作れます。
            </Text>
            {finishAsk ? (
              <View style={s.rowWrap}>
                <Btn s={s} label="終了して作成する" tone="primary" onPress={finish} />
                <Btn s={s} label="続ける" onPress={cancelFinish} />
              </View>
            ) : (
              <View style={s.rowWrap}>
                <Btn s={s} label="終了して作成" onPress={showFinish} />
              </View>
            )}
            <Banner s={s} text={finishError} error />
          </View>
        ) : null}
      </ScrollView>
      {writable ? (
        <Composer ctx={ctx} thread={thread} onFinishConfirm={showFinish} />
      ) : (
        <View style={s.composer}>
          <Text style={s.muted}>このプロジェクトでは閲覧のみです(投稿はできません)</Text>
        </View>
      )}
      <Zoom s={s} url={zoom} onClose={setZoom} />
    </View>
  );
}
