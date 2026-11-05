// 送信失敗は画面には常に同じ文言を出し、詳しい理由(内部ID・英語の内部文言を含みうる)はログにだけ残す。
export const SEND_FAILED_NOTICE = "送れませんでした。時間をおいてもう一度試してください";

export function sendErrorNotice(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  console.warn(`[topos-confirm-box] send failed: ${raw}`);
  return SEND_FAILED_NOTICE;
}
