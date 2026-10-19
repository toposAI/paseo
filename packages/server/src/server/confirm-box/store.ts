import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 確認箱(confirm box)のイベントストア。Python側 antigravity/utils/notify_box.py と
 * ディスク上のデータ契約を共有する(ToposAI-Mini-Project)。
 *
 * - ディレクトリ: TOPOS_CONFIRM_BOX_DIR、無ければ ~/.local/state/toposai/confirm_box
 * - events-YYYYMM.jsonl へ 1行1イベントを O_APPEND の単一writeで追記(ロック不要。
 *   書き手が複数プロセス(Python watchdog群+このデーモン)でも行が混ざらない)。
 * - 壊れた行・未知のイベントは無視する。
 * - heartbeat.json は原子的(tmp→rename)に上書きし、Python側の死活検査が読む。
 */

export type ConfirmBoxUrgency = "urgent" | "normal";
export type ConfirmBoxState = "new" | "read" | "approved";
export type ConfirmBoxAckAction = "read" | "approve";

export interface ConfirmBoxItem {
  id: string;
  ts: number;
  urgency: ConfirmBoxUrgency;
  source: string;
  subject: string;
  body: string;
  origin: string;
  state: ConfirmBoxState;
  pushedAt: number | null;
}

export interface ConfirmBoxSummary {
  unread: number;
  urgentUnread: number;
  total: number;
}

export interface ConfirmBoxHeartbeat {
  ts: number;
  pid: number;
  version: string;
  lastScanAt: number;
  lastPushAt: number | null;
  unpushedUrgent: number;
}

export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;
export const SOURCE_MAX = 80;

const EVENTS_FILE = /^events-\d{6}\.jsonl$/;

export function resolveConfirmBoxDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOPOS_CONFIRM_BOX_DIR;
  if (override && override.trim().length > 0) {
    return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  }
  return path.join(os.homedir(), ".local", "state", "toposai", "confirm_box");
}

function eventsFileName(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `events-${d.getFullYear()}${mm}.jsonl`;
}

interface FileCursor {
  offset: number;
  remainder: string;
}

export class ConfirmBoxStore {
  private readonly items = new Map<string, ConfirmBoxItem>();
  private readonly order: string[] = [];
  private readonly cursors = new Map<string, FileCursor>();

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** ディスク上の新しい追記分だけを取り込む。戻り値は新規に畳み込んだイベント数。 */
  refresh(): number {
    let names: string[];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((n) => EVENTS_FILE.test(n))
        .sort();
    } catch {
      return 0;
    }
    let applied = 0;
    for (const name of names) {
      applied += this.readFile(name);
    }
    return applied;
  }

  private readFile(name: string): number {
    const filePath = path.join(this.dir, name);
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return 0;
    }
    const cursor = this.cursors.get(name) ?? { offset: 0, remainder: "" };
    if (size < cursor.offset) {
      // ファイルが縮んだ(手動で切詰め等)。最初から読み直す。
      cursor.offset = 0;
      cursor.remainder = "";
    }
    if (size === cursor.offset) {
      this.cursors.set(name, cursor);
      return 0;
    }
    const length = size - cursor.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, cursor.offset);
    } finally {
      fs.closeSync(fd);
    }
    cursor.offset = size;
    const text = cursor.remainder + buffer.toString("utf8");
    const lines = text.split("\n");
    cursor.remainder = lines.pop() ?? ""; // 末尾の未完了行は次回に持ち越す
    this.cursors.set(name, cursor);
    let applied = 0;
    for (const line of lines) {
      if (this.applyLine(line)) applied += 1;
    }
    return applied;
  }

  private applyLine(line: string): boolean {
    if (!line.trim()) return false;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof ev !== "object" || ev === null) return false;
    const e = ev as Record<string, unknown>;
    switch (e.t) {
      case "item":
        return this.applyItem(e);
      case "ack":
        return this.applyAck(e);
      case "ackall":
        return this.applyAckAll(e);
      case "push":
        return this.applyPush(e);
      default:
        return false;
    }
  }

  private applyItem(e: Record<string, unknown>): boolean {
    if (typeof e.id !== "string" || !e.id || this.items.has(e.id)) return false;
    if (typeof e.ts !== "number") return false;
    const str = (value: unknown, fallback: string) =>
      typeof value === "string" ? value : fallback;
    this.items.set(e.id, {
      id: e.id,
      ts: e.ts,
      urgency: e.urgency === "urgent" ? "urgent" : "normal",
      source: str(e.source, "unknown"),
      subject: str(e.subject, ""),
      body: str(e.body, ""),
      origin: str(e.origin, "unknown"),
      state: "new",
      pushedAt: null,
    });
    this.order.push(e.id);
    return true;
  }

  private applyAck(e: Record<string, unknown>): boolean {
    const item = typeof e.id === "string" ? this.items.get(e.id) : undefined;
    if (!item) return false;
    if (e.action === "approve") item.state = "approved";
    else if (item.state === "new") item.state = "read";
    return true;
  }

  private applyAckAll(e: Record<string, unknown>): boolean {
    const before = typeof e.before === "number" ? e.before : 0;
    for (const item of this.items.values()) {
      if (item.state === "new" && item.ts <= before) item.state = "read";
    }
    return true;
  }

  private applyPush(e: Record<string, unknown>): boolean {
    const item = typeof e.id === "string" ? this.items.get(e.id) : undefined;
    if (!item) return false;
    item.pushedAt = typeof e.ts === "number" ? e.ts : this.now();
    return true;
  }

  private append(event: Record<string, unknown>): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(event)}\n`;
    // appendFileSync は O_APPEND で開き1回のwriteで書く(Python側と同じ方式)。
    fs.appendFileSync(path.join(this.dir, eventsFileName(this.now())), line, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /** 書込後に自分のイベントも畳み込むため、追記してすぐrefreshする。 */
  private appendAndApply(event: Record<string, unknown>): void {
    this.append(event);
    this.refresh();
  }

  addItem(input: {
    subject: string;
    body?: string;
    urgency?: string;
    source?: string;
    origin?: string;
  }): ConfirmBoxItem {
    const id = randomBytes(8).toString("hex");
    this.appendAndApply({
      t: "item",
      id,
      ts: this.now(),
      urgency: input.urgency === "urgent" ? "urgent" : "normal",
      source: (input.source ?? "api").slice(0, SOURCE_MAX),
      subject: input.subject.slice(0, SUBJECT_MAX),
      body: (input.body ?? "").slice(0, BODY_MAX),
      origin: input.origin ?? "api",
    });
    return this.items.get(id)!;
  }

  ack(id: string, action: ConfirmBoxAckAction): boolean {
    this.refresh();
    if (!this.items.has(id)) return false;
    this.appendAndApply({ t: "ack", id, ts: this.now(), action });
    return true;
  }

  ackAll(): number {
    this.refresh();
    const before = this.now();
    const count = this.summary().unread;
    if (count > 0) this.appendAndApply({ t: "ackall", ts: before, action: "read", before });
    return count;
  }

  markPushed(ids: string[]): void {
    for (const id of ids) {
      if (this.items.has(id)) this.append({ t: "push", id, ts: this.now() });
    }
    this.refresh();
  }

  list(view: "active" | "all", limit: number): ConfirmBoxItem[] {
    const out: ConfirmBoxItem[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const item = this.items.get(this.order[i])!;
      if (view === "all" || item.state === "new") out.push({ ...item });
    }
    return out;
  }

  summary(): ConfirmBoxSummary {
    let unread = 0;
    let urgentUnread = 0;
    for (const item of this.items.values()) {
      if (item.state !== "new") continue;
      unread += 1;
      if (item.urgency === "urgent") urgentUnread += 1;
    }
    return { unread, urgentUnread, total: this.items.size };
  }

  allItems(): ConfirmBoxItem[] {
    return this.order.map((id) => this.items.get(id)!);
  }

  writeHeartbeat(hb: ConfirmBoxHeartbeat): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dir, "heartbeat.json");
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hb), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}
