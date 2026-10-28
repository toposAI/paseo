/**
 * 開発の優先順位(台帳の全件)。並べ替えは長押し/ドラッグ(下の useDragReorder)だけ。
 * 2026-10-28 ユーザー指示で ▲▼ ボタンを撤去し、行の中にアーカイブのアイコン・順位から外す ⇣ を置いた。
 * 行をタップすると中身(説明・関連する子スレ・未決の判断)を開く(何が残っているかをその場で見る)。
 * 自由記述(「Xを上げて」)の送信・返答表示。解釈と台帳更新は別プロセスが行い、
 * ここは台帳と返答を30秒ごと(送信直後は即時)に読み直すだけ。
 *
 * 2026-10-23 ユーザー指示で件数の切り捨てを撤去した(以前は先頭10件だけ描画していて、
 * 11件目以降が画面から消え、並べ替えの書き戻しで台帳からも消えていた)。上限は台帳側の受け入れ上限だけ。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { onBoxChanged } from "./events.js";
import { ArchiveIcon } from "./Icons.js";
import {
  priorityArchiveRpc,
  priorityDetailRpc,
  priorityListRpc,
  priorityMoveRpc,
  prioritySayRpc,
  priorityStandingRpc,
} from "../shared/contract.js";
import type { PriorityDetail, PriorityListOutput, PriorityProject } from "../shared/contract.js";

/** 中身に出す子スレ1件(契約の `thread` と同じ形。`thread` は null になりうるので NonNullable)。 */
type DetailThread = NonNullable<PriorityDetail["thread"]>;

const REFRESH_MS = 30_000;

type Styles = Record<string, object>;
interface Colors {
  foreground: string;
  foregroundMuted: string;
  border: string;
  accent: string;
}

const LONG_PRESS_MS = 350;
const MOUSE_THRESHOLD_PX = 4;
const HANDLE_THRESHOLD_PX = 3;
const TOUCH_CANCEL_PX = 10;
/** 指をこの範囲で離したらタップ(行の中身を開く)。これを超えて動いたらスクロール扱いで何もしない。 */
const TAP_PX = 6;
/** 一覧の行間(px)。下の `gap4` と必ず同じ値にする(ドラッグ中の行の詰め方を計算に使う)。 */
const ROW_GAP = 4;
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
 * ドラッグに到らなかった短いタップ(握り以外・`TAP_PX` 以内)は onTap(row) で拾う。
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
      if (!r.hasAttribute("data-priority-row")) continue;
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
    // 行だけを拾う(中身パネルなど、行の間に挟まる要素を数に入れない)
    const rowEls = () =>
      (Array.from(el.children) as HTMLElement[]).filter((r) => r.hasAttribute("data-priority-row"));

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
      if (target0.closest("button,[role=button],[data-priority-detail]")) return;
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
  Platform.OS === "web" ? { touchAction: "none", cursor: "grab", paddingRight: 2 } : {}
) as object;
const handleDataSet = { dragHandle: "1" };
// 1行に収める(2026-10-28 ユーザー指示『アーカイブのためだけに1行増えてんの』『縦の幅を詰める』)。
// 折り返すとアイコンが2行目へ落ちていたので、名前は省略表示にして右端へアイコンだけを並べる。
const rankRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 6,
};
const grow = { flex: 1, minWidth: 0 };
const rowCard = { paddingVertical: 4, paddingHorizontal: 6, gap: 0 };
const rankNo = { minWidth: 16, textAlign: "right" as const };
const iconBtn = {
  padding: 4,
  borderRadius: 4,
  opacity: 0.75,
  ...(Platform.OS === "web" ? { cursor: "pointer" } : {}),
} as object;
const plainRow = [rowCard, rankRow];
const gap4 = { gap: ROW_GAP };
// 並べ替えが見る「行」の印(行の間に中身パネルを挟むので、行だけを拾えるようにする)
const rowDataSet = { priorityRow: "1" };
// 中身パネルは行の中に入るので、行の扱い(長押し・タップ・並べ替え)から除く印
const detailDataSet = { priorityDetail: "1" };
const gap6 = { gap: 6 };
const gap8 = { gap: 8 };
const detailCard = { gap: 4 };
const detailThreadRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 6,
  paddingVertical: 2,
};
const rowActionGap = [rankRow, gap8];

function StatusChip({ text, color }: { text: string; color: string }) {
  const st = useMemo(
    () => ({
      fontSize: 11,
      color,
      borderColor: color,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
    }),
    [color],
  );
  return <Text style={st}>{text}</Text>;
}

function RankRow({
  project,
  index,
  colors,
  styles,
  onArchive,
  onStanding,
}: {
  project: PriorityProject;
  index: number;
  colors: Colors;
  styles: Styles;
  onArchive: (p: PriorityProject) => void;
  onStanding: (p: PriorityProject) => void;
}) {
  const archive = useCallback(() => onArchive(project), [onArchive, project]);
  const toStanding = useCallback(() => onStanding(project), [onStanding, project]);
  const cardStyle = useMemo(() => [styles.card, rowCard, rankRow, dragStyle], [styles.card]);
  const labelStyle = useMemo(() => [styles.text, grow], [styles.text]);
  const noStyle = useMemo(() => [styles.muted, rankNo, noSelect], [styles.muted]);
  const running = project.running ?? 0;
  const label = `${project.isNew ? "【新規】" : ""}${project.thread ? `${project.name} ›` : project.name}`;
  return (
    <View style={cardStyle}>
      <View style={handleStyle} {...({ dataSet: handleDataSet } as object)}>
        <Text style={styles.muted}>⋮⋮</Text>
      </View>
      <Text style={noStyle}>{index + 1}</Text>
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
      {running > 0 ? <StatusChip text={`動${running}`} color={colors.accent} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="順位から外して常時の方針にする"
        style={iconBtn}
        onPress={toStanding}
      >
        <Text style={styles.muted}>⇣</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="アーカイブ"
        style={iconBtn}
        onPress={archive}
      >
        <ArchiveIcon color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

/** 台帳の行(順位の無い「常時の方針」とアーカイブ済み)の共通の見た目。 */
function LedgerRow({
  text,
  actionLabel,
  styles,
  extra,
  onAction,
}: {
  text: string;
  actionLabel: string;
  styles: Styles;
  extra?: string;
  onAction: () => void;
}) {
  const textStyle = useMemo(() => [styles.muted, grow], [styles.muted]);
  return (
    <View style={plainRow}>
      <Text style={textStyle} numberOfLines={1}>
        {text}
      </Text>
      {extra ? <Text style={styles.muted}>{extra}</Text> : null}
      <Pressable accessibilityRole="button" style={iconBtn} onPress={onAction}>
        <Text style={styles.muted}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function StandingRow({
  project,
  styles,
  onUnstand,
}: {
  project: PriorityProject;
  styles: Styles;
  onUnstand: (p: PriorityProject) => void;
}) {
  const unstand = useCallback(() => onUnstand(project), [onUnstand, project]);
  return (
    <LedgerRow
      text={`${project.name}(順位なし・常に効かせる方針)`}
      actionLabel="戻す"
      extra={project.running ? `動${project.running}` : undefined}
      styles={styles}
      onAction={unstand}
    />
  );
}

function RestoreRow({
  project,
  styles,
  onRestore,
}: {
  project: PriorityProject;
  styles: Styles;
  onRestore: (p: PriorityProject) => void;
}) {
  const restore = useCallback(() => onRestore(project), [onRestore, project]);
  return <LedgerRow text={project.name} actionLabel="戻す" styles={styles} onAction={restore} />;
}

function ThreadLine({
  thread,
  styles,
  onOpenThread,
}: {
  thread: DetailThread;
  styles: Styles;
  onOpenThread: (agentId: string) => void;
}) {
  const textStyle = useMemo(() => [styles.text, grow], [styles.text]);
  const open = useCallback(() => onOpenThread(thread.agentId), [onOpenThread, thread.agentId]);
  return (
    <Pressable accessibilityRole="button" style={detailThreadRow} onPress={open}>
      <Text style={textStyle} numberOfLines={1}>
        {thread.title}
      </Text>
      <Text style={styles.muted}>{`${thread.status}/${thread.machineState ?? "?"}`}</Text>
    </Pressable>
  );
}

/** 一覧の行をタップして開く「中身」。何が残っているか(担当スレ・同じ題名の子スレ・未決の判断)を出す。 */
function DetailPanel({
  id,
  data,
  styles,
  loading,
  standing,
  onOpenThread,
  onSetStanding,
  onClose,
}: {
  id: string;
  data: PriorityDetail | null;
  styles: Styles;
  loading: boolean;
  standing: boolean;
  onOpenThread: (agentId: string) => void;
  onSetStanding: (id: string, on: boolean) => void;
  onClose: () => void;
}) {
  const toggleStanding = useCallback(
    () => onSetStanding(id, !standing),
    [id, onSetStanding, standing],
  );
  const rows = useMemo(() => {
    if (!data) return [];
    return data.thread ? [data.thread, ...data.related] : data.related;
  }, [data]);
  const panelStyle = useMemo(() => [styles.card, detailCard], [styles.card]);
  const standingLabel = standing ? "順位の一覧へ戻す" : "常時の方針へ";
  if (loading && !data) {
    return (
      <View style={detailCard}>
        <Text style={styles.muted}>読み込み中…</Text>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={detailCard}>
        <Text style={styles.muted}>中身を取れませんでした</Text>
      </View>
    );
  }
  return (
    <View style={panelStyle} {...({ dataSet: detailDataSet } as object)}>
      <Text style={styles.subject}>中身</Text>
      <Text style={styles.text}>{data.note ? `説明: ${data.note}` : "説明は台帳に未記入です"}</Text>
      <Text style={styles.muted}>{`子スレ ${rows.length} 件(生きている順)`}</Text>
      {rows.length === 0 ? (
        <Text style={styles.muted}>この項目に紐づく子スレは登録簿に見つかりません</Text>
      ) : (
        rows.map((t) => (
          <ThreadLine key={t.agentId} thread={t} styles={styles} onOpenThread={onOpenThread} />
        ))
      )}
      <Text style={styles.muted}>{`未決の判断 ${data.pendingQuestions.length} 件`}</Text>
      {data.pendingQuestions.slice(0, 5).map((q) => (
        <Text key={q.id} style={styles.text} numberOfLines={2}>
          {`・${q.subject}`}
        </Text>
      ))}
      <View style={rowActionGap}>
        <Pressable accessibilityRole="button" style={styles.btn} onPress={toggleStanding}>
          <Text style={styles.btnText}>{standingLabel}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.btn} onPress={onClose}>
          <Text style={styles.btnText}>閉じる</Text>
        </Pressable>
      </View>
    </View>
  );
}

type ConfirmKind = "archive" | "standing" | "unstand" | "restore";
interface Confirm {
  kind: ConfirmKind;
  project: PriorityProject;
}

function confirmText(c: Confirm): string {
  const n = c.project.running ?? 0;
  const live = n > 0 ? `動いているものが ${n} 件あります。` : "";
  if (c.kind === "archive") {
    return `「${c.project.name}」をアーカイブしますか? ${live}${
      n > 0 ? "アーカイブしても子スレは止めず、一覧から外すだけです。" : ""
    }`;
  }
  if (c.kind === "standing") {
    return `「${c.project.name}」を順位の一覧から外して常時の方針へ移しますか? ${live}`;
  }
  if (c.kind === "restore") return `「${c.project.name}」を一覧に戻しますか?`;
  return `「${c.project.name}」を順位の一覧(末尾)に戻しますか?`;
}

/** 押した直後に一度だけ出す確認。動いているものがある行は件数と「子スレは止めない」を明示する。 */
function ConfirmPrompt({
  confirm,
  busy,
  styles,
  onYes,
  onNo,
}: {
  confirm: Confirm;
  busy: boolean;
  styles: Styles;
  onYes: () => void;
  onNo: () => void;
}) {
  const box = useMemo(() => [styles.card, rowCard, gap6], [styles.card]);
  return (
    <View style={box}>
      <Text style={styles.text}>{confirmText(confirm)}</Text>
      <View style={rowActionGap}>
        <Pressable
          accessibilityRole="button"
          style={busy ? styles.btn : styles.btnRec}
          disabled={busy}
          onPress={onYes}
        >
          <Text style={busy ? styles.btnText : styles.btnRecText}>{busy ? "処理中…" : "はい"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.btn} disabled={busy} onPress={onNo}>
          <Text style={styles.btnText}>やめる</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 台帳を読み書きする部分(表示の分岐を持たないので、画面の関数は短く保てる)。 */
function usePriorityLedger() {
  const list = useRpc(priorityListRpc);
  const move = useRpc(priorityMoveRpc);
  const say = useRpc(prioritySayRpc);
  const archiveRpc = useRpc(priorityArchiveRpc);
  const standingRpc = useRpc(priorityStandingRpc);
  const detailRpc = useRpc(priorityDetailRpc);
  const [data, setData] = useState<PriorityListOutput | null>(null);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<PriorityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 開くたびに番号を進め、古い番号の応答は捨てる(速く行を続けて押すと、前の行の中身が後から上書きする)
  const detailSeq = useRef(0);

  const fail = useCallback(
    (e: unknown) => setNotice(e instanceof Error ? e.message : String(e)),
    [],
  );
  const reload = useCallback(async () => {
    try {
      setData(await list({}));
    } catch (e) {
      fail(e);
    }
  }, [fail, list]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    const off = onBoxChanged(() => void reload());
    return () => {
      clearInterval(timer);
      off();
    };
  }, [reload]);

  // ドラッグを離した瞬間に画面だけ先に並べ替える。サーバーの応答後 `reload` が正しい並びで上書きする
  // (失敗しても既に読み直し済みなので、古い並びのまま残らない)
  const setLocalOrder = useCallback((from: number, to: number) => {
    setData((d) => {
      if (!d || from === to) return d;
      const projects = [...d.projects];
      const [row] = projects.splice(from, 1);
      if (!row) return d;
      projects.splice(to, 0, row);
      return { ...d, projects };
    });
  }, []);

  const shift = useCallback(
    async (id: string, toRank: number) => {
      try {
        setNotice((await move({ id, toRank })).message);
      } catch (e) {
        fail(e);
      }
      void reload();
    },
    [fail, move, reload],
  );

  const archive = useCallback(
    async (id: string, archived: boolean) => {
      try {
        setNotice((await archiveRpc({ id, archived })).message);
      } catch (e) {
        fail(e);
      }
      void reload();
    },
    [archiveRpc, fail, reload],
  );

  const stand = useCallback(
    async (id: string, on: boolean) => {
      try {
        setNotice((await standingRpc({ id, standing: on })).message);
      } catch (e) {
        fail(e);
      }
      void reload();
    },
    [fail, reload, standingRpc],
  );

  const openDetail = useCallback(
    async (id: string) => {
      const seq = ++detailSeq.current;
      setDetail(null); // 前の行の中身が新しく開いた行の下に出ないよう先に消す
      setDetailLoading(true);
      try {
        const next = await detailRpc({ id });
        if (seq === detailSeq.current) setDetail(next);
      } catch (e) {
        if (seq === detailSeq.current) {
          setDetail(null);
          fail(e);
        }
      }
      if (seq === detailSeq.current) setDetailLoading(false);
    },
    [detailRpc, fail],
  );

  const sendText = useCallback(
    async (raw: string) => {
      const t = raw.trim();
      if (!t) return false;
      try {
        const r = await say({ text: t });
        setNotice(r.message);
        void reload();
        return r.ok;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [fail, reload, say],
  );

  return {
    data,
    notice,
    detail,
    detailLoading,
    reload,
    setLocalOrder,
    shift,
    archive,
    stand,
    openDetail,
    sendText,
  };
}

export function PriorityView({
  styles,
  colors,
  onOpenThread,
}: {
  styles: Styles;
  colors: Colors;
  /** 中身からスレを開く。agentId が null の時は理由の表示を呼び出し側が行う。 */
  onOpenThread: (agentId: string | null, name: string) => void;
}) {
  const led = usePriorityLedger();
  const [showArchived, setShowArchived] = useState(false);
  const [showStanding, setShowStanding] = useState(true);
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const dataRef = useRef<PriorityListOutput | null>(null);
  dataRef.current = led.data;
  const listRef = useRef<View>(null);

  const openDetail = useCallback(
    (id: string) => {
      setDetailId(id);
      void led.openDetail(id);
    },
    [led],
  );
  const drop = useCallback(
    (from: number, to: number) => {
      const p = dataRef.current?.projects[from];
      if (!p) return;
      // 楽観更新: 離した位置へ即時に並べ替え、サーバーへの反映と再読込は後から(失敗したら応答時の読み直しで戻る)
      led.setLocalOrder(from, to);
      void led.shift(p.id, to + 1);
    },
    [led],
  );
  const tap = useCallback(
    (row: number) => {
      const p = dataRef.current?.projects[row];
      if (p) openDetail(p.id);
    },
    [openDetail],
  );
  const orderKey = (led.data?.projects ?? []).map((p) => p.id).join("|");
  useDragReorder(listRef, orderKey, drop, tap);

  const runConfirm = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    const { kind, project } = confirm;
    if (kind === "archive") await led.archive(project.id, true);
    else if (kind === "restore") await led.archive(project.id, false);
    else await led.stand(project.id, kind === "standing");
    setBusy(false);
    setConfirm(null);
  }, [confirm, led]);
  const askArchive = useCallback(
    (p: PriorityProject) => setConfirm({ kind: "archive", project: p }),
    [],
  );
  const askStanding = useCallback(
    (p: PriorityProject) => setConfirm({ kind: "standing", project: p }),
    [],
  );
  const askRestore = useCallback(
    (p: PriorityProject) => setConfirm({ kind: "restore", project: p }),
    [],
  );
  const askUnstand = useCallback(
    (p: PriorityProject) => setConfirm({ kind: "unstand", project: p }),
    [],
  );
  const noConfirm = useCallback(() => setConfirm(null), []);
  const closeDetail = useCallback(() => setDetailId(null), []);
  const toggleArchived = useCallback(() => setShowArchived((v) => !v), []);
  const toggleStanding = useCallback(() => setShowStanding((v) => !v), []);
  const openRelated = useCallback((agentId: string) => onOpenThread(agentId, ""), [onOpenThread]);
  const setStandingFromDetail = useCallback((id: string, on: boolean) => {
    const all = [...(dataRef.current?.projects ?? []), ...(dataRef.current?.standing ?? [])];
    const p = all.find((x) => x.id === id);
    if (p) setConfirm({ kind: on ? "standing" : "unstand", project: p });
  }, []);
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
  const sendPress = useCallback(
    () => void led.sendText(text).then((ok) => ok && setText("")),
    [led, text],
  );

  const replies = useMemo(() => (led.data?.replies ?? []).toReversed(), [led.data]);
  const projects = led.data?.projects ?? [];
  const standing = led.data?.standing ?? [];
  const archived = led.data?.archived ?? [];
  const runningTotal = projects.reduce((n, p) => n + (p.running ?? 0), 0);
  const detailStanding = standing.some((p) => p.id === detailId);

  // 中身を開いている行が**一覧**から外れたら(アーカイブ・方針へ)閉じる。パネルを描くのは projects の中だけ
  // なので、standing/archived へ移った行も「無い」と見る(移った先で開き直すと、戻したときに古い中身が出る)
  useEffect(() => {
    const d = led.data;
    if (!detailId || !d) return;
    if (!d.projects.some((p) => p.id === detailId)) setDetailId(null);
  }, [detailId, led.data]);

  return (
    <View style={gap8}>
      <Text style={styles.muted}>
        {`開発の優先順位(全${projects.length}件・今動いている子スレ ${runningTotal} 件)。行タップで中身(説明・子スレ・未決の判断)を開きます。並べ替えは長押し(PCはドラッグ)。右端の箱アイコンでアーカイブ、⇣ で常時の方針へ。どちらも戻せます。確認箱の判断は上位の項目が先に並びます`}
      </Text>
      {led.notice ? <Text style={styles.muted}>{led.notice}</Text> : null}
      {confirm ? (
        <ConfirmPrompt
          confirm={confirm}
          busy={busy}
          styles={styles}
          onYes={runConfirm}
          onNo={noConfirm}
        />
      ) : null}
      <View ref={listRef} style={gap4}>
        {projects.map((p, i) => (
          <View key={p.id} style={gap4} {...({ dataSet: rowDataSet } as object)}>
            <RankRow
              project={p}
              index={i}
              colors={colors}
              styles={styles}
              onArchive={askArchive}
              onStanding={askStanding}
            />
            {/* 中身は押した行の**直下**に出す(上に出すと、下の方の行を押したとき画面の外に出る) */}
            {detailId === p.id ? (
              <DetailPanel
                id={p.id}
                data={led.detail}
                styles={styles}
                loading={led.detailLoading}
                standing={detailStanding}
                onOpenThread={openRelated}
                onSetStanding={setStandingFromDetail}
                onClose={closeDetail}
              />
            ) : null}
          </View>
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
      {standing.length > 0 ? (
        <Pressable accessibilityRole="button" style={styles.btn} onPress={toggleStanding}>
          <Text style={styles.btnText}>
            {`常時の方針 ${standing.length} 件を${showStanding ? "隠す" : "見る"}`}
          </Text>
        </Pressable>
      ) : null}
      {showStanding
        ? standing.map((p) => (
            <StandingRow key={p.id} project={p} styles={styles} onUnstand={askUnstand} />
          ))
        : null}
      {archived.length > 0 ? (
        <Pressable accessibilityRole="button" style={styles.btn} onPress={toggleArchived}>
          <Text style={styles.btnText}>
            {`アーカイブ済み ${archived.length} 件を${showArchived ? "隠す" : "見る"}`}
          </Text>
        </Pressable>
      ) : null}
      {showArchived
        ? archived.map((p) => (
            <RestoreRow key={p.id} project={p} styles={styles} onRestore={askRestore} />
          ))
        : null}
      {replies.map((r) => (
        <Text key={`${r.ts}-${r.by}`} style={styles.muted}>
          {r.by === "ack" ? "受領" : r.by}: {r.text}
        </Text>
      ))}
    </View>
  );
}
