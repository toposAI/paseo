/**
 * 開発の優先順位(台帳の全件)。▲▼で直接並べ替え(解釈を介さないので誤解釈が起きない)と、
 * PC=ドラッグ&ドロップ、iPhone=長押し(または左端の握り⋮⋮)して指を動かす、でも並べ替える(下の useDragReorder)。
 * 自由記述(「Xを上げて」)の送信・返答表示。解釈と台帳更新は別プロセスが行い、
 * ここは台帳と返答を30秒ごと(送信直後は即時)に読み直すだけ。
 *
 * 2026-10-23 ユーザー指示で件数の切り捨てを撤去した(以前は先頭10件だけ描画していて、
 * 11件目以降が画面から消え、並べ替えの書き戻しで台帳からも消えていた)。上限は台帳側の受け入れ上限だけ。
 * 行のタップで担当スレを開く(開く先は確認箱側のペイン=PCは右、iPhoneは全画面)。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { onBoxChanged } from "./events.js";
import { priorityListRpc, priorityMoveRpc, prioritySayRpc } from "../shared/contract.js";
import type { PriorityListOutput } from "../shared/contract.js";

const REFRESH_MS = 30_000;

type Styles = Record<string, object>;
interface Colors {
  foreground: string;
  foregroundMuted: string;
  border: string;
}

const LONG_PRESS_MS = 350;
const MOUSE_THRESHOLD_PX = 4;
const HANDLE_THRESHOLD_PX = 3;
const TOUCH_CANCEL_PX = 10;
/** 指をこの範囲で離したらタップ(行を開く)。これを超えて動いたらスクロール扱いで何もしない。 */
const TAP_PX = 6;
const ROW_GAP = 8;
const SLIDE = "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";
const LIFT_SHADOW = "0 10px 24px rgba(0,0,0,0.28)";

/**
 * 並べ替えのドラッグ(Todoist 風)。長押しで行が浮く → 指に追従 → 他の行が滑らかに場所を空ける → 離すと吸い付く。
 * web 上の DOM を直接見て transform だけを動かす(react-native-web の View は div。指に追従する
 * 描画に React の再描画を挟まないので滑らか)。
 * - マウス: 4px 動かしたらドラッグ開始。
 * - タッチ: 左端の握り(data-drag-handle・touch-action:none)は即ドラッグ、行本体は350ms長押しで開始
 *   (それまでに10px動けばスクロール扱いで中止)。長押し中の iOS のコールアウト/選択は CSS と contextmenu で抑止。
 * - ドラッグ中はスクロールさせない(touchmove を passive:false で止める)。
 * 離したら吸い付くアニメーションの後に onDrop(from, to) を呼ぶ。transform の掃除は並び(orderKey)が
 * 変わった直後の layout effect(描画前)で行うので、並べ替え後に一瞬ずれて見えることがない。
 * ドラッグに到らなかった短いタップ(握り以外・`TAP_PX` 以内)は onTap(row) で拾う。行を包む Pressable で
 * 拾わないのは、`onDown` が `button` を無視するため(包むと PC で行本体からのドラッグができなくなる)。
 */
function useDragReorder(
  listRef: React.RefObject<View | null>,
  orderKey: string,
  onDrop: (from: number, to: number) => void,
  onTap: (row: number) => void,
) {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  const resetStyles = useCallback(() => {
    const el = listRef.current as unknown as HTMLElement | null;
    if (!el) return;
    for (const r of Array.from(el.children) as HTMLElement[]) {
      r.style.transform = "";
      r.style.transition = "";
      r.style.zIndex = "";
      r.style.boxShadow = "";
      r.style.willChange = "";
    }
  }, [listRef]);

  // 並びが変わった(=楽観更新が描画された)直後、描画前に transform を外す
  useLayoutEffect(() => {
    if (Platform.OS === "web") resetStyles();
  }, [orderKey, resetStyles]);

  useEffect(() => {
    if (Platform.OS !== "web") return undefined;
    const el = listRef.current as unknown as HTMLElement | null;
    if (!el) return undefined;
    const rowEls = () => Array.from(el.children) as HTMLElement[];

    let from = -1;
    let target = -1;
    let active = false;
    let settling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let isTouch = false;
    let fromHandle = false;
    let rects: DOMRect[] = [];

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      detach();
      from = -1;
      target = -1;
      active = false;
    };
    const slotOffset = (to: number): number => {
      let sum = 0;
      if (to > from) for (let k = from + 1; k <= to; k++) sum += rects[k].height + ROW_GAP;
      else for (let k = to; k < from; k++) sum -= rects[k].height + ROW_GAP;
      return sum;
    };
    const apply = (dy: number) => {
      const rows = rowEls();
      const h = rects[from].height + ROW_GAP;
      rows.forEach((r, k) => {
        if (k === from) {
          r.style.transform = `translateY(${dy}px) scale(1.03)`;
        } else if (k > from && k <= target) {
          r.style.transform = `translateY(${-h}px)`;
        } else if (k < from && k >= target) {
          r.style.transform = `translateY(${h}px)`;
        } else {
          r.style.transform = "";
        }
      });
    };
    const begin = () => {
      const rows = rowEls();
      if (from < 0 || from >= rows.length) {
        cleanup();
        return;
      }
      rects = rows.map((r) => r.getBoundingClientRect());
      active = true;
      target = from;
      rows.forEach((r, k) => {
        r.style.willChange = "transform";
        r.style.transition = k === from ? "box-shadow 150ms" : SLIDE;
      });
      rows[from].style.zIndex = "20";
      rows[from].style.boxShadow = LIFT_SHADOW;
      apply(0);
      if (typeof navigator.vibrate === "function") navigator.vibrate(12);
    };
    function onMove(e: PointerEvent) {
      if (from < 0 || settling) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!active) {
        const dist = Math.hypot(dx, dy);
        if (isTouch && !fromHandle) {
          if (dist > TOUCH_CANCEL_PX) cleanup();
        } else if (dist > (isTouch ? HANDLE_THRESHOLD_PX : MOUSE_THRESHOLD_PX)) {
          begin();
        }
        return;
      }
      e.preventDefault();
      const minDy = rects[0].top - rects[from].top;
      const maxDy = rects[rects.length - 1].bottom - rects[from].bottom;
      const cdy = Math.max(minDy, Math.min(maxDy, dy));
      const center = rects[from].top + rects[from].height / 2 + cdy;
      let next = from;
      if (cdy > 0) {
        for (let k = from + 1; k < rects.length; k++) {
          if (center > rects[k].top + rects[k].height / 2) next = k;
        }
      } else {
        for (let k = from - 1; k >= 0; k--) {
          if (center < rects[k].top + rects[k].height / 2) next = k;
        }
      }
      target = next;
      apply(cdy);
    }
    function onUp(e: PointerEvent) {
      if (!active) {
        const tap =
          from >= 0 && !fromHandle && Math.hypot(e.clientX - startX, e.clientY - startY) <= TAP_PX;
        const row = from;
        cleanup();
        if (tap) onTapRef.current(row);
        return;
      }
      const f = from;
      const to = target;
      detach();
      settling = true;
      const rows = rowEls();
      // 吸い付く: 浮いた行を空いた場所へ戻してから(並びが変わる場合は)onDrop
      rows[f].style.transition = `${SLIDE}, box-shadow 150ms`;
      rows[f].style.transform = `translateY(${slotOffset(to)}px) scale(1)`;
      rows[f].style.boxShadow = "none";
      settleTimer = setTimeout(() => {
        settleTimer = null;
        settling = false;
        cleanup();
        if (f !== to) onDropRef.current(f, to);
        else resetStyles();
        // 念のため(並びが変わらなかった場合の取り残し防止)
        setTimeout(resetStyles, 800);
      }, 210);
    }
    function onCancel() {
      const wasActive = active;
      cleanup();
      if (wasActive) resetStyles();
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || from >= 0 || settling) return;
      const target0 = e.target as HTMLElement;
      if (target0.closest("button,[role=button]")) return;
      const row = rowEls().findIndex((r) => r.contains(target0));
      if (row < 0) return;
      from = row;
      startX = e.clientX;
      startY = e.clientY;
      isTouch = e.pointerType === "touch" || e.pointerType === "pen";
      fromHandle = target0.closest("[data-drag-handle]") !== null;
      if (isTouch && !fromHandle) timer = setTimeout(begin, LONG_PRESS_MS);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };
    // ドラッグ中(と長押し待ち中の右クリック/コールアウト)はスクロール・メニューを止める
    const onTouchMove = (e: TouchEvent) => {
      if (active && e.cancelable) e.preventDefault();
    };
    const onContext = (e: Event) => {
      if (from >= 0) e.preventDefault();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("contextmenu", onContext);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("contextmenu", onContext);
      if (settleTimer) clearTimeout(settleTimer);
      cleanup();
      resetStyles();
    };
  }, [listRef, resetStyles]);
}

const noSelect = (
  Platform.OS === "web"
    ? {
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
      }
    : {}
) as object;
const dragStyle = (Platform.OS === "web" ? { cursor: "grab", ...noSelect } : noSelect) as object;
const handleStyle = (
  Platform.OS === "web" ? { touchAction: "none", cursor: "grab", paddingHorizontal: 6 } : {}
) as object;
const handleDataSet = { dragHandle: "1" };
const rankRow = { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 };
const grow = { flex: 1 };

function RankRow({
  id,
  index,
  name,
  hasThread,
  isNew,
  styles,
  onShift,
}: {
  id: string;
  index: number;
  name: string;
  /** 担当スレが台帳に入っているか。未設定でも行は押せて、押したら理由を出す(黙って無反応にしない)。 */
  hasThread: boolean;
  /** 動いているスレから自動で足され、まだ並べ替えていない行。「新規」の印を出す。 */
  isNew: boolean;
  styles: Styles;
  onShift: (id: string, toRank: number) => Promise<void>;
}) {
  const up = useCallback(() => void onShift(id, index), [onShift, id, index]);
  const down = useCallback(() => void onShift(id, index + 2), [onShift, id, index]);
  const card = useMemo(() => [styles.card, rankRow, dragStyle], [styles.card]);
  const label = useMemo(() => [styles.text, grow], [styles.text]);
  return (
    <View style={card}>
      <View style={handleStyle} {...({ dataSet: handleDataSet } as object)}>
        <Text style={styles.muted}>⋮⋮</Text>
      </View>
      <Text style={styles.subject}>{index + 1}</Text>
      {/* 担当スレが入っていれば「› スレ」を付ける(押すと開くという印)。入れ子の Text は作らず1行にまとめる。 */}
      <Text style={label} numberOfLines={2}>
        {`${isNew ? "【新規】" : ""}${hasThread ? `${name} › スレ` : name}`}
      </Text>
      <Pressable accessibilityRole="button" style={styles.btn} onPress={up}>
        <Text style={styles.btnText}>▲</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.btn} onPress={down}>
        <Text style={styles.btnText}>▼</Text>
      </Pressable>
    </View>
  );
}

export function PriorityView({
  styles,
  colors,
  onOpenThread,
}: {
  styles: Styles;
  colors: Colors;
  /** 行タップ。担当スレ未設定の時は agentId が null のまま呼ぶ(理由の表示は呼び出し側)。 */
  onOpenThread: (agentId: string | null, name: string) => void;
}) {
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
    const off = onBoxChanged(() => void reload());
    return () => {
      clearInterval(timer);
      off();
    };
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
      if (!p) return;
      // 楽観更新: 離した位置へ即時に並べ替え、サーバーへの反映と再読込は後から
      setData((d) => {
        if (!d) return d;
        const projects = d.projects.slice();
        const [moved] = projects.splice(from, 1);
        projects.splice(to, 0, moved);
        return { ...d, projects };
      });
      void shift(p.id, to + 1);
    },
    [shift],
  );
  const orderKey = (data?.projects ?? []).map((p) => p.id).join("|");
  const tap = useCallback(
    (row: number) => {
      const p = dataRef.current?.projects[row];
      if (p) onOpenThread(p.thread, p.name);
    },
    [onOpenThread],
  );
  useDragReorder(listRef, orderKey, drop, tap);

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
        開発の優先順位(全{data?.projects.length ?? 0}
        件)。行タップで担当スレを開く。ドラッグ/長押しか▲▼で
        並べ替え。確認箱の判断も上位プロジェクトが先に並びます
      </Text>
      {notice ? <Text style={styles.muted}>{notice}</Text> : null}
      <View ref={listRef} style={gap8}>
        {data?.projects.map((p, i) => (
          <RankRow
            key={p.id}
            id={p.id}
            index={i}
            name={p.name}
            hasThread={p.thread !== null}
            isNew={p.isNew === true}
            styles={styles}
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
