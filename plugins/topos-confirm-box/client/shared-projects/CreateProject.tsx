/**
 * 新しい共有プロジェクトを作る。名前・説明・招待する人(登録ユーザーの候補から選ぶ)。
 * 作成後はそのプロジェクトの画面を開く。概要の聞き取り(AIが目的を聞く)は、開いた画面が始める。
 */
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { parseCandidates, parseDetail, type Candidate } from "../../shared/shared-projects-api.js";
import { emitProjectsChanged, type CallApi } from "./api.js";
import type { OpenScreen } from "./types.js";
import { Banner, Btn, Chip, type Colors, type S } from "./ui.js";

const NAME_MAX = 80;
const DESC_MAX = 200;

export function CreateProject({
  s,
  colors,
  call,
  openScreen,
  screenId,
}: {
  s: S;
  colors: Colors;
  call: CallApi;
  openScreen: OpenScreen;
  screenId: string;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    void call("candidates").then((r) => {
      if (!alive) return null;
      if (r.ok) setCandidates(parseCandidates(r.data));
      else setLoadError(r.message);
      return null;
    });
    return () => {
      alive = false;
    };
  }, [call]);

  const toggle = useCallback(
    (uid: string) =>
      setPicked((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid])),
    [],
  );

  const create = useCallback(() => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    void call("create", {
      body: { name: name.trim(), description: description.trim(), invitees: picked },
    }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return null;
      }
      const created = parseDetail(r.data);
      emitProjectsChanged();
      if (created) openScreen({ screenId, params: { id: created.id } });
      else setError("作成しましたが、結果を読めませんでした。サイドバーから開いてください");
      return null;
    });
  }, [busy, name, description, picked, call, openScreen, screenId]);

  return (
    <ScrollView style={s.root} contentContainerStyle={s.page}>
      <Text style={s.title}>新しい共有プロジェクト</Text>
      <Text style={s.label}>名前</Text>
      <TextInput
        style={s.input}
        value={name}
        onChangeText={setName}
        placeholder="例: 夏休みの旅行"
        placeholderTextColor={colors.foregroundMuted}
        maxLength={NAME_MAX}
      />
      <Text style={s.label}>説明(省略できます)</Text>
      <TextInput
        style={s.inputMulti}
        value={description}
        onChangeText={setDescription}
        placeholderTextColor={colors.foregroundMuted}
        multiline
        maxLength={DESC_MAX}
      />
      <Text style={s.label}>招待する人</Text>
      <Banner s={s} text={loadError} error />
      {candidates.length === 0 && !loadError ? (
        <Text style={s.muted}>招待できる人がいません(あとから追加できます)</Text>
      ) : null}
      <View style={s.rowWrap}>
        {candidates.map((c) => (
          <Chip
            key={c.userId}
            s={s}
            label={c.name}
            on={picked.includes(c.userId)}
            onPress={toggle}
            value={c.userId}
          />
        ))}
      </View>
      <Banner s={s} text={error} error />
      <View style={s.rowWrap}>
        <Btn
          s={s}
          label={busy ? "作成中…" : "作成する"}
          tone="primary"
          onPress={create}
          disabled={busy || !name.trim()}
        />
      </View>
    </ScrollView>
  );
}
