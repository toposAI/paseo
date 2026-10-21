/**
 * 開発の優先順位(1〜10位)。▲▼で直接並べ替え(解釈を介さないので誤解釈が起きない)と、
 * PC=ドラッグ&ドロップ、iPhone=長押しして指を動かす、でも並べ替える(下の useDragReorder)。
 * 自由記述(「Xを上げて」)の送信・返答表示。解釈と台帳更新は別プロセスが行い、
 * ここは台帳と返答を30秒ごと(送信直後は即時)に読み直すだけ。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { priorityListRpc, priorityMoveRpc, prioritySayRpc } from "../shared/contract.js";
import type { PriorityListOutput } from "../shared/contract.js";

const REFRESH_MS = 30_000;

type Styles = Record<string, object>;
interface Colors {
  foreground: string;
  foregroundMuted: string;
  border: string;
}

const LONG_PRESS_MS = 450;
const MOUSE_THRESHOLD_PX = 4;
const TOUCH_CANCEL_PX = 8;

interface DragState {
  from: number;
  over: number;
}

/**
 * 並べ替えのドラッグ。web 上の DOM を直接見る(react-native-web の View は div)。
 * マウス: 4px 動かしたらドラッグ開始。タッチ: 450ms 長押しで開始(それまでに8px動けばスクロール扱いで中止)。
 * ドラッグ中はスクロールを止め、離した位置の順位へ onDrop(from, over) を呼ぶ。
 */
function useDragReorder(
  listRef: React.RefObject<View | null>,
  count: number,
  onDrop: (from: number, to: number) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    if (Platform.OS !== "web") return undefined;
    const el = listRef.current as unknown as HTMLElement | null;
    if (!el) return undefined;
    const rowIndexAt = (y: number): number => {
      const rows = Array.from(el.children) as HTMLElement[];
      const hit = rows.findIndex((r) => y < r.getBoundingClientRect().bottom);
      return hit < 0 ? rows.length - 1 : hit;
    };
    const rowOf = (target: EventTarget | null): number => {
      const rows = Array.from(el.children) as HTMLElement[];
      return rows.findIndex((r) => r.contains(target as Node));
    };

    let from = -1;
    let over = -1;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let isTouch = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      from = -1;
      over = -1;
      active = false;
      setDrag(null);
    };
    const begin = () => {
      active = true;
      over = from;
      setDrag({ from, over });
    };
    function onMove(e: PointerEvent) {
      if (from < 0) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!active) {
        const dist = Math.hypot(dx, dy);
        if (isTouch) {
          if (dist > TOUCH_CANCEL_PX) cleanup();
        } else if (dist > MOUSE_THRESHOLD_PX) {
          begin();
        }
        return;
      }
      e.preventDefault();
      const next = rowIndexAt(e.clientY);
      if (next !== over) {
        over = next;
        setDrag({ from, over });
      }
    }
    function onUp() {
      const f = from;
      const o = over;
      const was = active;
      cleanup();
      if (was && f >= 0 && o >= 0 && f !== o) onDropRef.current(f, o);
    }
    function onCancel() {
      cleanup();
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || from >= 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button,[role=button]")) return;
      const idx = rowOf(target);
      if (idx < 0) return;
      from = idx;
      startX = e.clientX;
      startY = e.clientY;
      isTouch = e.pointerType === "touch" || e.pointerType === "pen";
      if (isTouch) timer = setTimeout(begin, LONG_PRESS_MS);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };
    // 長押し成立後はスクロールさせない(passive:false で止める)
    const onTouchMove = (e: TouchEvent) => {
      if (active) e.preventDefault();
    };
    const onContext = (e: Event) => {
      if (from >= 0 && isTouch) e.preventDefault();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("contextmenu", onContext);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("contextmenu", onContext);
      cleanup();
    };
  }, [listRef, count]);

  return drag;
}

const dragStyle = (Platform.OS === "web" ? { cursor: "grab", userSelect: "none" } : {}) as object;
const dragSource = { opacity: 0.4 };
const dropTarget = { borderColor: "#3b82f6", borderWidth: 2 };
const rankRow = { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 };
const grow = { flex: 1 };

function RankRow({
  id,
  index,
  name,
  styles,
  dragging,
  target,
  onShift,
}: {
  id: string;
  index: number;
  name: string;
  styles: Styles;
  dragging: boolean;
  target: boolean;
  onShift: (id: string, toRank: number) => Promise<void>;
}) {
  const up = useCallback(() => void onShift(id, index), [onShift, id, index]);
  const down = useCallback(() => void onShift(id, index + 2), [onShift, id, index]);
  const card = useMemo(
    () => [
      styles.card,
      rankRow,
      dragStyle,
      dragging ? dragSource : null,
      target ? dropTarget : null,
    ],
    [styles.card, dragging, target],
  );
  const label = useMemo(() => [styles.text, grow], [styles.text]);
  return (
    <View style={card}>
      <Text style={styles.subject}>{index + 1}</Text>
      <Text style={label}>{name}</Text>
      <Pressable accessibilityRole="button" style={styles.btn} onPress={up}>
        <Text style={styles.btnText}>▲</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.btn} onPress={down}>
        <Text style={styles.btnText}>▼</Text>
      </Pressable>
    </View>
  );
}

export function PriorityView({ styles, colors }: { styles: Styles; colors: Colors }) {
  const list = useRpc(priorityListRpc);
  const move = useRpc(priorityMoveRpc);
  const say = useRpc(prioritySayRpc);
  const [data, setData] = useState<PriorityListOutput | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const dataRef = useRef<PriorityListOutput | null>(null);
  dataRef.current = data;

  const reload = useCallback(async () => {
    try {
      setData(await list({}));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const shift = useCallback(
    async (id: string, toRank: number) => {
      try {
        setNotice((await move({ id, toRank })).message);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      void reload();
    },
    [move, reload],
  );

  const listRef = useRef<View>(null);
  const drop = useCallback(
    (from: number, to: number) => {
      const p = dataRef.current?.projects[from];
      if (p) void shift(p.id, to + 1);
    },
    [shift],
  );
  const drag = useDragReorder(listRef, data?.projects.length ?? 0, drop);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const r = await say({ text: t });
      setNotice(r.message);
      if (r.ok) setText("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
    void reload();
  }, [say, text, reload]);
  const sendPress = useCallback(() => void send(), [send]);

  const input = useMemo(
    () => ({
      color: colors.foreground,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: 8,
      fontSize: 14,
    }),
    [colors],
  );
  const replies = useMemo(() => (data?.replies ?? []).toReversed(), [data]);

  return (
    <View style={gap8}>
      <Text style={styles.muted}>
        開発の優先順位(ドラッグ/長押しか▲▼で並べ替え。確認箱の判断も上位プロジェクトが先に並びます)
      </Text>
      {notice ? <Text style={styles.muted}>{notice}</Text> : null}
      <View ref={listRef} style={gap8}>
        {data?.projects.map((p, i) => (
          <RankRow
            key={p.id}
            id={p.id}
            index={i}
            name={p.name}
            styles={styles}
            dragging={drag?.from === i}
            target={drag !== null && drag.over === i && drag.from !== i}
            onShift={shift}
          />
        ))}
      </View>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="例: 139番を上げて"
        placeholderTextColor={colors.foregroundMuted}
        multiline
        style={input}
      />
      <Pressable accessibilityRole="button" style={styles.btnRec} onPress={sendPress}>
        <Text style={styles.btnRecText}>送る</Text>
      </Pressable>
      {replies.map((r) => (
        <Text key={`${r.ts}-${r.by}`} style={styles.muted}>
          {r.by === "ack" ? "受領" : r.by}: {r.text}
        </Text>
      ))}
    </View>
  );
}

const gap8 = { gap: 8 };
