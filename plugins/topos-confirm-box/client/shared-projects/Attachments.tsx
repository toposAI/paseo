/**
 * スレッドの添付の表示。画像は縮小表示(押すと拡大)、画像以外はファイル名で出して押すと保存。
 * 実体は Topos の添付取得(attachment)で取り、base64 のデータURLとして受ける(許可リストの操作のみ)。
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Image, Platform, Pressable, Text } from "react-native";
import {
  formatBytes,
  parseAttachmentData,
  type Attachment,
} from "../../shared/shared-projects-api.js";
import type { CallApi } from "./api.js";
import type { S } from "./ui.js";

const cache = new Map<string, string>();

async function loadData(
  call: CallApi,
  id: string,
  aid: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const hit = cache.get(`${id}:${aid}`);
  if (hit) return { ok: true, url: hit };
  const r = await call("attachment", { id, aid });
  if (!r.ok) return { ok: false, message: r.message };
  const d = parseAttachmentData(r.data);
  if (!d) return { ok: false, message: "添付を読めませんでした" };
  cache.set(`${id}:${aid}`, d.dataUrl);
  return { ok: true, url: d.dataUrl };
}

function saveAs(url: string, name: string): void {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

interface Props {
  s: S;
  call: CallApi;
  projectId: string;
  att: Attachment;
  onZoom: (url: string) => void;
}

function ImageThumb({ s, call, projectId, att, onZoom }: Props) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void loadData(call, projectId, att.id).then((r) => {
      if (!alive) return null;
      if (r.ok) setUrl(r.url);
      else setError(r.message);
      return null;
    });
    return () => {
      alive = false;
    };
  }, [call, projectId, att.id]);
  const source = useMemo(() => ({ uri: url }), [url]);
  const zoom = useCallback(() => onZoom(url), [onZoom, url]);
  if (error) return <Text style={s.error}>{`${att.name}: ${error}`}</Text>;
  if (!url) return <Text style={s.muted}>{`${att.name} を読み込み中…`}</Text>;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`${att.name}を拡大`}
      onPress={zoom}
    >
      <Image source={source} style={s.thumb} resizeMode="cover" />
    </Pressable>
  );
}

function FileTag({ s, call, projectId, att }: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = useCallback(() => {
    setBusy(true);
    setError("");
    void loadData(call, projectId, att.id).then((r) => {
      setBusy(false);
      if (r.ok) saveAs(r.url, att.name);
      else setError(r.message);
      return null;
    });
  }, [call, projectId, att.id, att.name]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${att.name}を保存`}
      onPress={save}
      style={s.fileTag}
    >
      <Text
        style={s.btnText}
      >{`${att.name}(${formatBytes(att.size)})${busy ? " 取得中…" : ""}`}</Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </Pressable>
  );
}

export const AttachmentView = memo(function AttachmentView(props: Props) {
  if (props.att.withdrawn) return <Text style={props.s.muted}>{props.att.name}</Text>;
  return props.att.kind === "image" ? <ImageThumb {...props} /> : <FileTag {...props} />;
});
