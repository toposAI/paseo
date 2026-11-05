// 送信失敗の理由を画面に出す前に、内部ID(UUID・8桁の16進)と英語の内部文言を取り除く。
// 完全なUUID、または英字と数字を両方含む8桁の16進(日付 20261105 や child-… の連なりは対象外)。
const UUID =
  /(?<![\w-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9]*[a-f])(?=[a-f]*[0-9])[0-9a-f]{8})(?![\w-])/gi;

export function sendErrorNotice(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/agent not found/i.test(raw)) return "送れません: 宛先のスレが見つかりません";
  const cleaned = raw
    .replace(UUID, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  return cleaned ? `送れません: ${cleaned}` : "送れません";
}
