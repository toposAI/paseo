import type express from "express";

import { renderConfirmBoxPage } from "./page.js";
import { BODY_MAX, SUBJECT_MAX, type ConfirmBoxStore } from "./store.js";

/**
 * 確認箱のHTTP API。パスは /api/confirm-box/ 配下(web-ui の SPA fallback は /api/ を除外するため
 * 競合しない)。認証は daemon 全体の bearer ミドルウェアに従う(これより前に app.use 済み)。
 */
export function registerConfirmBoxRoutes(options: {
  app: express.Express;
  store: ConfirmBoxStore;
  getHeartbeatAgeMs: () => number | null;
}): void {
  const { app, store } = options;
  const base = "/api/confirm-box";

  app.get([base, `${base}/`], (_req, res) => {
    res.type("html").send(renderConfirmBoxPage());
  });

  app.get(`${base}/summary`, (_req, res) => {
    store.refresh();
    res.json(store.summary());
  });

  app.get(`${base}/items`, (req, res) => {
    store.refresh();
    const view = req.query.view === "all" ? "all" : "active";
    const parsed = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;
    res.json({ items: store.list(view, limit), summary: store.summary() });
  });

  app.post(`${base}/items/:id/ack`, (req, res) => {
    const action = req.body?.action === "approve" ? "approve" : "read";
    if (!store.ack(req.params.id, action)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ ok: true, summary: store.summary() });
  });

  app.post(`${base}/ack-all`, (_req, res) => {
    const count = store.ackAll();
    res.json({ ok: true, acked: count, summary: store.summary() });
  });

  // 外部(Mac上の他プロセス・他ホスト)からの受信口。Pythonは通常ファイル直書きなので主に将来用。
  app.post(`${base}/items`, (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
    if (!subject || subject.length > SUBJECT_MAX) {
      res.status(400).json({ error: `subject is required (max ${SUBJECT_MAX} chars)` });
      return;
    }
    if (typeof body?.body === "string" && body.body.length > BODY_MAX) {
      res.status(400).json({ error: `body too long (max ${BODY_MAX} chars)` });
      return;
    }
    const item = store.addItem({
      subject,
      body: typeof body?.body === "string" ? body.body : "",
      urgency: typeof body?.urgency === "string" ? body.urgency : "normal",
      source: typeof body?.source === "string" ? body.source : "api",
      origin: "api",
    });
    res.status(201).json({ ok: true, id: item.id });
  });

  app.get(`${base}/health`, (_req, res) => {
    res.json({
      status: "ok",
      heartbeatAgeMs: options.getHeartbeatAgeMs(),
      summary: store.summary(),
    });
  });
}
