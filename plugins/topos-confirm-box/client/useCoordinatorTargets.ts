/**
 * 確認箱の宛先検証に使う司令塔のID(起こしデーモンの正本)。カードを開いている間だけ1回引く。
 *
 * サーバの `topos.confirmbox.coordinator` をそのまま使う(既存RPCの読み手を増やすだけで、
 * サーバ側は変えない)。引けなければ null のまま — 呼び出し側は司令塔へ振り替えない。
 */
import { useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { coordinatorTargetRpc } from "../shared/contract.js";

export interface CoordinatorTargets {
  agentId: string | null;
  hubIds?: readonly string[] | undefined;
}

export function useCoordinatorTargets(enabled: boolean): CoordinatorTargets | null {
  const rpc = useRpc(coordinatorTargetRpc);
  const [targets, setTargets] = useState<CoordinatorTargets | null>(null);
  useEffect(() => {
    if (!enabled || targets) return undefined;
    let alive = true;
    rpc({})
      .then((res) => {
        if (alive) setTargets(res);
        return null;
      })
      .catch(() => {
        // 引けなければ総司令塔へ振り替えない(宛先をそのまま開く)。
      });
    return () => {
      alive = false;
    };
  }, [enabled, targets, rpc]);
  return targets;
}
