/**
 * topos-customizations: 在席の読み出し(読み取り専用)。
 * Web UI が15秒ごとに送る「画面が見えているか・最後に触った時刻」をデーモンのメモリから集計して返す。
 * 外部の常駐スクリプト(使っていない間の圧縮など)が「ユーザーは今使っているか」を読むための口。
 */
export interface PresenceActivityInput {
  deviceType: "web" | "mobile";
  appVisible: boolean;
  lastActivityAt: Date;
  focusedAgentId: string | null;
}

export interface PresenceClient {
  deviceType: "web" | "mobile";
  appVisible: boolean;
  lastActivityAt: string;
  idleSeconds: number;
  focusedAgentId: string | null;
}

export interface PresenceSnapshot {
  now: string;
  clientCount: number;
  /** 全端末のうち最後に触られた時刻。端末が1つも無ければ null。 */
  lastActivityAt: string | null;
  /** 「画面が見えている端末」の中で最後に触られた時刻。見えている端末が無ければ null。 */
  lastVisibleActivityAt: string | null;
  /**
   * withinSeconds を渡したときだけ入る。「画面が見えていて、その秒数以内に触られた端末が1つでもあるか」。
   * 渡さなければ null(判定は呼び手に任せる)。
   */
  present: boolean | null;
  clients: PresenceClient[];
}

export function buildPresenceSnapshot(
  activities: readonly PresenceActivityInput[],
  nowMs: number,
  withinSeconds: number | null = null,
): PresenceSnapshot {
  const clients: PresenceClient[] = activities.map((a) => {
    // 時計のずれで未来になった値は「いま」に丸める(idleSeconds を負にしない)。
    const last = Math.min(a.lastActivityAt.getTime(), nowMs);
    return {
      deviceType: a.deviceType,
      appVisible: a.appVisible,
      lastActivityAt: new Date(last).toISOString(),
      idleSeconds: Math.floor((nowMs - last) / 1000),
      focusedAgentId: a.focusedAgentId,
    };
  });
  const latest = (list: PresenceClient[]): string | null =>
    list.length === 0
      ? null
      : list.reduce((m, c) => (c.lastActivityAt > m ? c.lastActivityAt : m), list[0]!.lastActivityAt);
  const visible = clients.filter((c) => c.appVisible);
  return {
    now: new Date(nowMs).toISOString(),
    clientCount: clients.length,
    lastActivityAt: latest(clients),
    lastVisibleActivityAt: latest(visible),
    present:
      withinSeconds === null ? null : visible.some((c) => c.idleSeconds <= withinSeconds),
    clients,
  };
}

/** `?withinSeconds=` の解釈。未指定・不正(非数・負・巨大)は null(=判定しない)。 */
export function parseWithinSeconds(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 7 * 24 * 3600) return null;
  return n;
}
