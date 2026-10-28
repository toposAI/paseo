/**
 * 投稿欄: 宛先(AI・全員・個人)、添付、本文、送信。
 * 宛先の意味(省略=AI宛、空=全員宛でAIなし、指名=通知)は Topos 側。ここは選択を配列にして渡すだけ。
 * 旧鍵(本文だけの鍵)では宛先・添付・AIを隠し、全員宛てに本文だけを送る。
 */
import { useCallback, useMemo, useState } from "react";
import { Image, Text, TextInput, View } from "react-native";
import { POST_TEXT_MAX } from "../../shared/shared-projects.js";
import {
  buildRecipients,
  formatBytes,
  parsePostResult,
  recipientSummary,
  type PostResult,
  type RecipientChoice,
} from "../../shared/shared-projects-api.js";
import { emitProjectsChanged } from "./api.js";
import type { ProjectCtx } from "./types.js";
import type { ThreadState } from "./useThread.js";
import { usePickFiles, type PickedItem } from "./usePickFiles.js";
import { Banner, Btn, Chip } from "./ui.js";

const AI_VALUE = "@ai";
const ALL_VALUE = "@all";
const DEFAULT_CHOICE: RecipientChoice = { ai: true, people: [] };

function PreviewItem({
  ctx,
  item,
  onRemove,
}: {
  ctx: ProjectCtx;
  item: PickedItem;
  onRemove: (k: string) => void;
}) {
  const { s } = ctx;
  const source = useMemo(() => ({ uri: item.preview }), [item.preview]);
  return (
    <View style={s.fileTag}>
      {item.preview ? <Image source={source} style={s.thumbSmall} resizeMode="cover" /> : null}
      <Text style={s.btnText}>{`${item.filename}(${formatBytes(item.size)})`}</Text>
      <Btn s={s} label="外す" onPress={onRemove} value={item.key} a11y={`${item.filename}を外す`} />
    </View>
  );
}

/** 投稿の本文。宛先 null は省略(Topos の既定=AI宛)、添付が無ければ attachments も省く。 */
function postBody(text: string, to: string[] | null, items: readonly PickedItem[]) {
  const attachments = items.map((i) => ({
    filename: i.filename,
    mime_type: i.mime_type,
    data_base64: i.data_base64,
  }));
  return {
    text,
    ...(to !== null ? { to } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function RecipientRow({
  ctx,
  choice,
  onPick,
}: {
  ctx: ProjectCtx;
  choice: RecipientChoice;
  onPick: (value: string) => void;
}) {
  const { s, detail, me } = ctx;
  const members = detail?.members ?? [];
  const everyone = !choice.ai && choice.people.length === 0;
  return (
    <>
      <View style={s.rowWrap}>
        <Text style={s.label}>宛先</Text>
        <Chip s={s} label="AI" on={choice.ai} onPress={onPick} value={AI_VALUE} />
        <Chip s={s} label="全員" on={everyone} onPress={onPick} value={ALL_VALUE} />
        {members
          .filter((m) => m.userId !== me)
          .map((m) => (
            <Chip
              key={m.userId}
              s={s}
              label={m.name}
              on={choice.people.includes(m.userId)}
              onPress={onPick}
              value={m.userId}
            />
          ))}
      </View>
      <Text style={s.muted}>{`宛先: ${recipientSummary(choice, members)}`}</Text>
    </>
  );
}

function llmErrorText(code: string): string {
  return code === "llm_failed"
    ? "AIの返信に失敗しました(投稿は届いています)。もう一度聞くには、あらためて投稿してください"
    : `AIの返信に失敗しました: ${code}`;
}

export function Composer({
  ctx,
  thread,
  onFinishConfirm,
}: {
  ctx: ProjectCtx;
  thread: ThreadState;
  onFinishConfirm: () => void;
}) {
  const { s, colors, call, id, me, config, limited } = ctx;
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<RecipientChoice>(DEFAULT_CHOICE);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [warn, setWarn] = useState("");

  const attachOn = !limited && config?.attach === true;
  const pick = usePickFiles({ maxBytes: config?.maxBytes ?? 0, maxCount: config?.maxCount ?? 0 });

  const pickRecipient = useCallback((value: string) => {
    if (value === AI_VALUE) setChoice((c) => ({ ...c, ai: !c.ai }));
    else if (value === ALL_VALUE) setChoice({ ai: false, people: [] });
    else
      setChoice((c) => ({
        ...c,
        people: c.people.includes(value)
          ? c.people.filter((p) => p !== value)
          : [...c.people, value],
      }));
  }, []);

  const hasContent = text.trim().length > 0 || pick.items.length > 0;
  const aiWillAnswer = !limited && choice.ai;

  const send = useCallback(async () => {
    if (sending || !hasContent) return;
    setSending(true);
    setNotice("");
    setWarn("");
    const to = limited ? [] : buildRecipients(choice);
    const r = await call("post", { id, body: postBody(text, to, pick.items) });
    setSending(false);
    if (!r.ok) {
      setNotice(r.message);
      // 時間切れは投稿が届いている可能性があるので取り直す
      if (r.reason === "timeout") void thread.reload();
      return;
    }
    const parsed: PostResult | null = parsePostResult(r.data, me, thread.names);
    setText("");
    pick.clear();
    setChoice(DEFAULT_CHOICE);
    if (parsed) {
      thread.append([parsed.message, parsed.reply].filter((m) => m !== null));
      if (parsed.llmError) setWarn(llmErrorText(parsed.llmError));
      if (parsed.finishConfirm) onFinishConfirm();
      if (parsed.overviewSaved) void ctx.reloadDetail();
    }
    emitProjectsChanged();
    void thread.reload();
  }, [
    sending,
    hasContent,
    limited,
    choice,
    pick,
    text,
    call,
    id,
    me,
    thread,
    onFinishConfirm,
    ctx,
  ]);

  const sendPress = useCallback(() => void send(), [send]);

  return (
    <View style={s.composer}>
      {limited ? (
        <Text style={s.muted}>
          この鍵では全員宛ての本文だけ送れます(宛先の指定・添付・AIへの質問は使えません)
        </Text>
      ) : (
        <RecipientRow ctx={ctx} choice={choice} onPick={pickRecipient} />
      )}
      {pick.items.length > 0 ? (
        <View style={s.rowWrap}>
          {pick.items.map((i) => (
            <PreviewItem key={i.key} ctx={ctx} item={i} onRemove={pick.remove} />
          ))}
        </View>
      ) : null}
      {pick.notice ? <Banner s={s} text={pick.notice} error /> : null}
      <TextInput
        style={s.inputLine}
        value={text}
        onChangeText={setText}
        placeholder={aiWillAnswer ? "メッセージ(AIに聞きます)" : "メッセージ"}
        placeholderTextColor={colors.foregroundMuted}
        multiline
        maxLength={POST_TEXT_MAX}
        editable={!sending}
      />
      <View style={s.rowBetween}>
        <View style={s.rowWrap}>
          {attachOn && pick.supported ? (
            <>
              <Btn s={s} label="画像を付ける" onPress={pick.pickImages} disabled={sending} />
              <Btn s={s} label="ファイルを付ける" onPress={pick.pickAny} disabled={sending} />
            </>
          ) : null}
        </View>
        <Btn
          s={s}
          label={sending ? "送信中…" : "送信"}
          tone="primary"
          onPress={sendPress}
          disabled={sending || !hasContent}
        />
      </View>
      {sending && aiWillAnswer ? <Text style={s.muted}>AIが考えています…</Text> : null}
      <Banner s={s} text={notice} error />
      <Banner s={s} text={warn} />
    </View>
  );
}
