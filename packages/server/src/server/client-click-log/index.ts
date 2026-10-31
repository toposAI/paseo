import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type express from "express";
import type pino from "pino";

/**
 * サイドバーのクリックが効かなくなる不具合の原因特定用。画面側が溜めた「どの要素がクリックを受けたか」を
 * 受け取って日別jsonlに追記するだけの口(topos-customizations)。本文・入力内容は受け取らない:
 * 許可した項目だけを短く切って保存し、それ以外は捨てる。認証は daemon 全体の bearer に従う。
 */
const EVENTS_MAX = 50;
const STRING_MAX = 120;
const DAILY_BYTES_MAX = 5 * 1024 * 1024;
const KINDS = new Set(["pointerdown", "click", "no-click", "drag-guard-cancel"]);

interface SanitizedTarget {
  tag: string;
  testId: string;
  role: string;
  cls: string;
  parents: string[];
}

function clip(value: unknown): string {
  return typeof value === "string" ? value.slice(0, STRING_MAX) : "";
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function sanitizeTarget(value: unknown): SanitizedTarget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const parents = Array.isArray(raw.parents) ? raw.parents.slice(0, 3).map(clip) : [];
  return {
    tag: clip(raw.tag),
    testId: clip(raw.testId),
    role: clip(raw.role),
    cls: clip(raw.cls),
    parents,
  };
}

export function sanitizeClickLogEvents(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value.slice(0, EVENTS_MAX)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) continue;
    out.push({
      kind: raw.kind,
      t: finite(raw.t),
      x: finite(raw.x),
      y: finite(raw.y),
      button: finite(raw.button),
      prevented: raw.prevented === true,
      inSidebar: raw.inSidebar === true,
      target: sanitizeTarget(raw.target),
      top: sanitizeTarget(raw.top),
    });
  }
  return out;
}

export function registerClientClickLogRoute(options: {
  app: express.Express;
  logger: pino.Logger;
  baseDir: string;
  now?: () => Date;
}): void {
  const { app, logger, baseDir } = options;
  const now = options.now ?? (() => new Date());

  app.post("/api/client-click-log", (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const events = sanitizeClickLogEvents(body?.events);
    if (events.length === 0) {
      res.status(400).json({ ok: false, reason: "no_valid_events" });
      return;
    }
    const at = now();
    const day = at.toISOString().slice(0, 10).replaceAll("-", "");
    const file = path.join(baseDir, `${day}.jsonl`);
    try {
      mkdirSync(baseDir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      if (size >= DAILY_BYTES_MAX) {
        res.status(429).json({ ok: false, reason: "daily_cap" });
        return;
      }
      const record = {
        receivedAt: at.toISOString(),
        session: clip(body?.session),
        reason: clip(body?.reason),
        events,
      };
      appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
      res.status(201).json({ ok: true, saved: events.length });
    } catch (error) {
      logger.warn({ err: error }, "client click log write failed");
      res.status(500).json({ ok: false, reason: "write_failed" });
    }
  });
}
