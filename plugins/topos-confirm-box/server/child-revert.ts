/**
 * 子スレ完了カードの「差し戻し」。処理の本体は登録簿側の `child_thread_registry.py revert`
 * (自動取り下げと同じ後始末+子スレへの通知+送達確認+読み返し)で、ここは呼び出しの引数組み立てと
 * 結果の文面化だけを持つ(二重実装しない)。
 */
export const REVERT_INSTRUCTION_LIMIT = 2000;

export function buildRevertArgs(script: string, agentId: string, instruction: string): string[] {
  // `--instruction=` 形式+`--`: 先頭が `-` の指示文・IDが引数として解釈されない
  return [
    script,
    "revert",
    `--instruction=${instruction.slice(0, REVERT_INSTRUCTION_LIMIT)}`,
    "--",
    agentId,
  ];
}

const LABELS: Record<string, string> = { registry: "登録簿", box: "確認箱", note: "実装ノート" };

export function summarizeRevert(stdout: string): { ok: boolean; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      message:
        "差し戻しの結果を読めませんでした(処理は走った可能性があります。一覧を更新して確かめてください)",
    };
  }
  const r = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") {
    return { ok: false, message: "差し戻しの結果が空でした(一覧を更新して確かめてください)" };
  }
  if (r.result === "not-applicable" && r.why === "coordinator") {
    return { ok: false, message: "司令塔のスレは差し戻せません" };
  }
  if (r.result === "not-applicable") {
    return {
      ok: false,
      message: "差し戻しの対象外です(既に差し戻し済み・確認箱で完了にした・完了待ちでない)",
    };
  }
  const verified = (r.verified ?? {}) as Record<string, boolean>;
  const bad = Object.keys(LABELS)
    .filter((k) => verified[k] !== true)
    .map((k) => LABELS[k]);
  const parts = [
    bad.length === 0 ? "差し戻しました" : `差し戻しましたが、${bad.join("・")}が戻っていません`,
  ];
  if (r.delivery === "delivered") parts.push("子スレのログに載りました(処理開始は未確認)");
  else if (r.delivery === "held-busy")
    parts.push("子スレが作業中のため通知は送っていません(スレを開いて直接伝えてください)");
  else if (r.delivery === "unverified")
    parts.push("子スレへ送りましたが、ログで確認できていません(未確認)");
  else parts.push("子スレへの送信に失敗しました(スレを開いて直接伝えてください)");
  return { ok: bad.length === 0, message: parts.join("。") };
}
