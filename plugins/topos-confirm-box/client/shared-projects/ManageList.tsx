/**
 * 一覧まわりの管理画面: アーカイブ済み(戻す)と並び順の変更。
 * 並び順・アーカイブは自分の一覧だけに効く(他のメンバーには影響しない。Topos側の仕様)。
 */
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { moveId, parseProjectRows, type ProjectRow } from "../../shared/shared-projects-api.js";
import { emitProjectsChanged, type CallApi } from "./api.js";
import { Banner, Btn, type S } from "./ui.js";

interface Common {
  s: S;
  call: CallApi;
}

function useRows(call: CallApi, archived: boolean) {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const r = await call("list", archived ? { query: { archived: "true" } } : {});
    setLoading(false);
    if (r.ok) {
      setRows(parseProjectRows(r.data));
      setError("");
    } else setError(r.message);
  }, [call, archived]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rows, setRows, loading, error, setError, load };
}

function ArchivedRow({
  s,
  row,
  onRestore,
}: {
  s: S;
  row: ProjectRow;
  onRestore: (id: string) => void;
}) {
  return (
    <View style={s.cardRow}>
      <View style={s.rowBetween}>
        <View style={s.grow}>
          <Text style={s.h2}>{row.name}</Text>
          {row.description ? <Text style={s.muted}>{row.description}</Text> : null}
        </View>
        <Btn
          s={s}
          label="戻す"
          onPress={onRestore}
          value={row.id}
          a11y={`${row.name}を一覧に戻す`}
        />
      </View>
    </View>
  );
}

export function ArchivedList({ s, call }: Common) {
  const { rows, loading, error, setError, load } = useRows(call, true);
  const restore = useCallback(
    (id: string) => {
      void call("unarchive", { id }).then(async (r) => {
        if (!r.ok) {
          setError(r.message);
          return null;
        }
        await load();
        emitProjectsChanged();
        return null;
      });
    },
    [call, load, setError],
  );
  return (
    <ScrollView style={s.root} contentContainerStyle={s.page}>
      <Text style={s.title}>アーカイブ済み</Text>
      {loading ? <Text style={s.muted}>読み込み中…</Text> : null}
      <Banner s={s} text={error} error />
      {!loading && !error && rows.length === 0 ? (
        <Text style={s.muted}>アーカイブしたプロジェクトはありません</Text>
      ) : null}
      {rows.map((r) => (
        <ArchivedRow key={r.id} s={s} row={r} onRestore={restore} />
      ))}
    </ScrollView>
  );
}

function OrderRow({
  s,
  row,
  first,
  last,
  onMove,
}: {
  s: S;
  row: ProjectRow;
  first: boolean;
  last: boolean;
  onMove: (value: string) => void;
}) {
  return (
    <View style={s.cardRow}>
      <View style={s.rowBetween}>
        <Text style={s.h2}>{row.name}</Text>
        <View style={s.row}>
          <Btn
            s={s}
            label="上へ"
            onPress={onMove}
            value={`up:${row.id}`}
            disabled={first}
            a11y={`${row.name}を上へ`}
          />
          <Btn
            s={s}
            label="下へ"
            onPress={onMove}
            value={`down:${row.id}`}
            disabled={last}
            a11y={`${row.name}を下へ`}
          />
        </View>
      </View>
    </View>
  );
}

export function OrderList({ s, call }: Common) {
  const { rows, setRows, loading, error, setError } = useRows(call, false);
  const move = useCallback(
    (value: string) => {
      const [dir, id] = value.split(":");
      const ids = moveId(
        rows.map((r) => r.id),
        id,
        dir === "up" ? -1 : 1,
      );
      const before = rows;
      setRows(ids.map((x) => before.find((r) => r.id === x)).filter((r) => r !== undefined));
      void call("order", { body: { ids } }).then((r) => {
        if (r.ok) {
          setError("");
          emitProjectsChanged();
        } else {
          setRows(before);
          setError(r.message);
        }
        return null;
      });
    },
    [rows, setRows, call, setError],
  );
  return (
    <ScrollView style={s.root} contentContainerStyle={s.page}>
      <Text style={s.title}>並び順を変える</Text>
      <Text style={s.muted}>自分の一覧の並びだけが変わります。</Text>
      {loading ? <Text style={s.muted}>読み込み中…</Text> : null}
      <Banner s={s} text={error} error />
      {rows.map((r, i) => (
        <OrderRow
          key={r.id}
          s={s}
          row={r}
          first={i === 0}
          last={i === rows.length - 1}
          onMove={move}
        />
      ))}
    </ScrollView>
  );
}
