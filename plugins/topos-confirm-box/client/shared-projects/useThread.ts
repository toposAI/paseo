/**
 * スレッド(投稿の一覧)の取得と既読。15秒ごとに最新側を取り直し、表示した最新の投稿まで既読にする。
 * 「前回までの要約」には、画面を開いた時点の既読位置が要る(開くとすぐ既読に進むので、最初の取得で控える)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseThread, type ThreadView } from "../../shared/shared-projects-api.js";
import { emitProjectsChanged, type CallApi } from "./api.js";

const THREAD_POLL_MS = 15_000;

export interface ThreadState {
  view: ThreadView | null;
  /** 発言者のIDと表示名(宛先の名前の解決に使う)。 */
  names: Record<string, string>;
  loading: boolean;
  error: string;
  /** 画面を開いた時点の最終既読 seq(最初の取得で1回だけ決める)。未取得は null。 */
  openedAtSeq: number | null;
  reload: () => Promise<void>;
  /** 投稿直後などに、取得を待たず末尾へ足す。 */
  append: (messages: ThreadView["messages"]) => void;
}

function readNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const names = (raw as { names?: unknown } | null)?.names;
  if (typeof names !== "object" || names === null) return out;
  for (const [k, v] of Object.entries(names)) if (typeof v === "string") out[k] = v;
  return out;
}

/** `reading` が true の間だけ(スレッドを表示している間だけ)既読にする。 */
export function useThread(call: CallApi, projectId: string, reading: boolean): ThreadState {
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const [view, setView] = useState<ThreadView | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openedAtSeq, setOpenedAtSeq] = useState<number | null>(null);
  const gen = useRef(0);
  const busy = useRef(false);

  // プロジェクトが変わったら前の内容・状態を持ち越さない
  useEffect(() => {
    gen.current += 1;
    busy.current = false;
    setView(null);
    setNames({});
    setLoading(true);
    setError("");
    setOpenedAtSeq(null);
  }, [projectId]);

  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const my = gen.current;
    try {
      const r = await call("thread", { id: projectId });
      if (my !== gen.current) return;
      if (!r.ok) {
        setError(r.message);
        setLoading(false);
        return;
      }
      const parsed = parseThread(r.data);
      if (!parsed) {
        setError("Topos の応答を読めませんでした");
        setLoading(false);
        return;
      }
      setError("");
      setView(parsed);
      setNames(readNames(r.data));
      setOpenedAtSeq((cur) => cur ?? parsed.lastReadSeq);
      setLoading(false);
      const shown = parsed.messages.reduce((m, x) => Math.max(m, x.seq), 0);
      if (readingRef.current && parsed.unread > 0 && shown > 0) {
        const done = await call("read", { id: projectId, body: { seq: shown } });
        if (done.ok && my === gen.current) emitProjectsChanged();
      }
    } finally {
      if (my === gen.current) busy.current = false;
    }
  }, [call, projectId]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // スレッドタブへ戻ったら、すぐ取り直して既読にする
  useEffect(() => {
    if (reading) void reload();
  }, [reading, reload]);

  const append = useCallback((messages: ThreadView["messages"]) => {
    setView((cur) => {
      if (!cur) return cur;
      const have = new Set(cur.messages.map((m) => m.seq));
      const add = messages.filter((m) => !have.has(m.seq));
      if (add.length === 0) return cur;
      const merged = [...cur.messages, ...add].sort((a, b) => a.seq - b.seq);
      return {
        ...cur,
        messages: merged,
        latestSeq: Math.max(cur.latestSeq, ...add.map((m) => m.seq)),
      };
    });
  }, []);

  return { view, names, loading, error, openedAtSeq, reload, append };
}
