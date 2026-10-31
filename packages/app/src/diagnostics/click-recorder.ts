/**
 * サイドバーのクリックが効かなくなる不具合の原因特定用の記録(topos-customizations)。
 * 直近のポインタ操作を「どの要素が受けたか」だけ溜め、「タップしたのに click が来ない」または
 * ドラッグ保険が発動したときに、既存サーバーの /api/client-click-log へ静かに送る。
 * 本文・入力内容は読まない(タグ名・testID・role・class・親3段だけ)。送信失敗は握りつぶす。
 */
export type ClickDiagKind =
  | "pointerdown"
  | "click"
  | "no-click"
  | "click-swallowed"
  | "drag-guard-cancel";

interface ElementDescriptor {
  tag: string;
  testId: string;
  role: string;
  cls: string;
  parents: string[];
}

interface ClickDiagEvent {
  kind: ClickDiagKind;
  t: number;
  x: number;
  y: number;
  button: number;
  prevented: boolean;
  inSidebar: boolean;
  target: ElementDescriptor | null;
  top: ElementDescriptor | null;
}

const BUFFER_MAX = 20;
const TAP_SLOP_PX = 6;
const CLICK_WAIT_MS = 600;
const FLUSH_MIN_INTERVAL_MS = 30_000;
const FLUSH_MAX_PER_SESSION = 10;
const ENDPOINT = "/api/client-click-log";

function describeElement(node: EventTarget | Element | null): ElementDescriptor | null {
  if (!(node instanceof Element)) return null;
  const label = (element: Element) =>
    `${element.tagName.toLowerCase()}#${element.getAttribute("data-testid") ?? ""}`;
  const parents: string[] = [];
  let current = node.parentElement;
  while (current && parents.length < 3) {
    parents.push(label(current));
    current = current.parentElement;
  }
  return {
    tag: node.tagName.toLowerCase(),
    testId: node.getAttribute("data-testid") ?? "",
    role: node.getAttribute("role") ?? "",
    cls: typeof node.className === "string" ? node.className : "",
    parents,
  };
}

export interface ClickRecorderDeps {
  win: Window;
  doc: Document;
  send: (payload: unknown) => void;
  now: () => number;
}

export interface ClickRecorder {
  recordGuardCancel: () => void;
  dispose: () => void;
}

export function createClickRecorder(deps: ClickRecorderDeps): ClickRecorder {
  const { win, doc, send, now } = deps;
  const session = Math.random().toString(36).slice(2, 10);
  const buffer: ClickDiagEvent[] = [];
  let down: { x: number; y: number } | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let flushCount = 0;
  let swallowPending = false;

  const build = (kind: ClickDiagKind, event: MouseEvent | null, x: number, y: number) => {
    const target = event?.target ?? null;
    const entry: ClickDiagEvent = {
      kind,
      t: now(),
      x,
      y,
      button: event?.button ?? -1,
      prevented: event?.defaultPrevented === true,
      inSidebar: target instanceof Element && target.closest('[data-testid*="sidebar"]') !== null,
      target: describeElement(target),
      top: describeElement(doc.elementFromPoint(x, y)),
    };
    buffer.push(entry);
    if (buffer.length > BUFFER_MAX) buffer.shift();
  };

  const flush = (reason: string, force: boolean) => {
    const at = now();
    if (flushCount >= FLUSH_MAX_PER_SESSION) return;
    if (!force && at - lastFlushAt < FLUSH_MIN_INTERVAL_MS) return;
    lastFlushAt = at;
    flushCount += 1;
    send({ session, reason, events: buffer.slice() });
  };

  const clearWait = () => {
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    clearWait();
    down = { x: event.clientX, y: event.clientY };
    build("pointerdown", event, event.clientX, event.clientY);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!down || event.button !== 0 || event.pointerType === "touch") return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    down = null;
    if (moved > TAP_SLOP_PX) return;
    clearWait();
    const { clientX, clientY } = event;
    waitTimer = setTimeout(() => {
      waitTimer = null;
      build("no-click", event, clientX, clientY);
      flush("no-click", false);
    }, CLICK_WAIT_MS);
  };
  const onClick = (event: MouseEvent) => {
    clearWait();
    build("click", event, event.clientX, event.clientY);
    // window の capture では見えたのに bubble に届かない = 途中(dnd-kit の document capture 等)で止められた。
    swallowPending = true;
    setTimeout(() => {
      if (!swallowPending) return;
      swallowPending = false;
      build("click-swallowed", event, event.clientX, event.clientY);
      flush("click-swallowed", false);
    }, 0);
  };
  const onClickBubble = () => {
    swallowPending = false;
  };

  win.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("pointerup", onPointerUp, true);
  win.addEventListener("click", onClick, true);
  win.addEventListener("click", onClickBubble, false);

  return {
    recordGuardCancel: () => {
      build("drag-guard-cancel", null, 0, 0);
      flush("drag-guard-cancel", true);
    },
    dispose: () => {
      clearWait();
      win.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("pointerup", onPointerUp, true);
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("click", onClickBubble, false);
    },
  };
}

let active: ClickRecorder | null = null;

export function installClickRecorder(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined" || active) {
    return () => {};
  }
  const recorder = createClickRecorder({
    win: window,
    doc: document,
    now: () => Date.now(),
    send: (payload) => {
      // サーバー側の口が無い(未入れ替え)・認証失敗・オフラインでも画面には何も起こさない。
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    },
  });
  active = recorder;
  return () => {
    recorder.dispose();
    active = null;
  };
}

export function recordDragGuardCancel(): void {
  active?.recordGuardCancel();
}
