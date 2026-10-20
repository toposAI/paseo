import type express from "express";

import {
  isSendableThread,
  selectChatTranscript,
  type ConfirmBoxChatTurn,
  type ConfirmBoxThreadGateway,
} from "./chat.js";
import { renderConfirmBoxPage } from "./page.js";
import {
  BODY_MAX,
  CHAT_QUESTION_MAX,
  SUBJECT_MAX,
  type ConfirmBoxDepth,
  type ConfirmBoxStore,
} from "./store.js";

/**
 * 確認箱のHTTP API。パスは /api/confirm-box/ 配下(web-ui の SPA fallback は /api/ を除外するため
 * 競合しない)。認証は daemon 全体の bearer ミドルウェアに従う(これより前に app.use 済み)。
 */
export function registerConfirmBoxRoutes(options: {
  app: express.Express;
  store: ConfirmBoxStore;
  getHeartbeatAgeMs: () => number | null;
  /** 元スレを開くリンク(`/h/<serverId>/agent/<id>`)に要る。未指定ならリンクを出さない。 */
  getServerId?: () => string;
  /** 元スレへの送信とタイムライン読み出し。agentManager は setupConfirmBox より後に
   * 生成されるため遅延getterで受ける。未指定ならチャット欄は「元スレを開く」だけになる。 */
  getThreadGateway?: () => ConfirmBoxThreadGateway | undefined;
}): void {
  const { app, store } = options;
  const base = "/api/confirm-box";

  app.get([base, `${base}/`], (_req, res) => {
    res.type("html").send(renderConfirmBoxPage({ serverId: options.getServerId?.() ?? "" }));
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
    // depth/chosen/chat_question は任意(UIが「どこまで開いて何を選んで決めたか」を載せる)。
    // 未知の値は store 側の正規化で落ちるので、ここでは形だけ見る。
    const body = req.body as Record<string, unknown> | undefined;
    const action = body?.action === "approve" ? "approve" : "read";
    const ok = store.ack(req.params.id, action, {
      depth: typeof body?.depth === "string" ? (body.depth as ConfirmBoxDepth) : undefined,
      chosen: typeof body?.chosen === "string" ? body.chosen : undefined,
      chatQuestion: typeof body?.chat_question === "string" ? body.chat_question : undefined,
    });
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ ok: true, summary: store.summary() });
  });

  // --- チャット欄(A案・2026-10-21 ユーザー決定) ---
  // 箱で聞くと元スレへ送られ、返答が箱に戻ってくる(箱を閉じずに聞ける)。
  // 送信はデーモン内から `sendPromptToAgent()` を呼ぶ経路を通す(フォークにエージェント宛の
  // HTTPルートは無く、全送信面がこの関所を通るため)。実装は bootstrap.ts が gateway として渡す。

  /** 質問を記録してから元スレへ送る。**記録が先**(送信に失敗しても質問文は学習ログに残る)。 */
  app.post(`${base}/items/:id/chat`, async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) {
      res.status(400).json({ error: "question is required" });
      return;
    }
    if (question.length > CHAT_QUESTION_MAX) {
      res.status(400).json({ error: `question too long (max ${CHAT_QUESTION_MAX} chars)` });
      return;
    }
    const clientMessageId = store.recordChatQuestion(req.params.id, question);
    if (!clientMessageId) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const item = store.getItem(req.params.id);
    const ref = item?.threadRef ?? null;
    if (!isSendableThread(ref)) {
      // Topos側のスレッドID等は送り先が無い。記録だけして理由を返す(UIは元スレを開く導線を出す)。
      res.json({ ok: true, sent: false, reason: "no_thread", clientMessageId });
      return;
    }
    const gateway = options.getThreadGateway?.();
    if (!gateway) {
      res.json({ ok: true, sent: false, reason: "gateway_unavailable", clientMessageId });
      return;
    }
    try {
      await gateway.send({ agentId: ref.id, question, clientMessageId });
      res.json({ ok: true, sent: true, clientMessageId });
    } catch (err) {
      // 記録は済んでいる。送れなかったことだけ返す(UIは元スレを開く導線を出す)。
      res.status(502).json({
        ok: false,
        sent: false,
        reason: "send_failed",
        error: err instanceof Error ? err.message : "send failed",
        clientMessageId,
      });
    }
  });

  /** 箱から聞いたこと(質問)と、元スレから取り込んだ返答。 */
  app.get(`${base}/items/:id/chat`, async (req, res) => {
    store.refresh();
    const item = store.getItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const questions = store.chatEntries(item.id).map((c) => ({
      question: c.question,
      ts: c.ts,
      clientMessageId: c.clientMessageId,
    }));
    const ref = item.threadRef;
    const gateway = isSendableThread(ref) ? options.getThreadGateway?.() : undefined;
    let turns: ConfirmBoxChatTurn[] = [];
    let transcriptError: string | null = null;
    if (gateway && isSendableThread(ref) && questions.length > 0) {
      try {
        turns = selectChatTranscript(
          await gateway.timeline(ref.id),
          questions.map((q) => q.clientMessageId),
        );
      } catch (err) {
        // デーモン再起動後は元スレがメモリから消えていてタイムラインを読めないことがある。
        // 推測で別の返答を出さないよう、空のまま理由だけ返す(UIは元スレを開く導線を出す)。
        transcriptError = err instanceof Error ? err.message : "timeline unavailable";
      }
    }
    res.json({
      questions,
      turns,
      canSend: isSendableThread(ref) && Boolean(gateway),
      transcriptError,
    });
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
