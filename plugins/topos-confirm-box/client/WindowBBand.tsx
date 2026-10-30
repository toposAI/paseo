/**
 * 窓口Bの会話の上の細い帯「指示 N件・赤1」。押すと指示一覧を開く。
 * 2026-10-30 ユーザー指示「Cもいいね。やって」。ホストが `band`(WindowBInstructions のパネル登録)から描く。
 *
 * 件数は一覧パネルと同じ RPC を30秒毎に引いた結果の `total` / `alerts`(`shared/windowb-band.ts`)。
 * 取れていない間(未取得・一度も取れていない)は帯を出さない。取得に失敗しても前回の値は残す
 * (`keepLastOnFailure`。取れない瞬間に「0件」へ戻さない)。
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginWorkspaceBandProps } from "@getpaseo/plugin/client";
import { windowBInstructionsRpc, type WindowBInstructionsOutput } from "../shared/contract.js";
import { keepLastOnFailure } from "../shared/windowb-instructions.js";
import { bandText } from "../shared/windowb-band.js";

const REFRESH_MS = 30_000;

function useBandData(): WindowBInstructionsOutput | null {
  const list = useRpc(windowBInstructionsRpc);
  const [data, setData] = useState<WindowBInstructionsOutput | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      list({ limit: 100 })
        .then((next) => {
          if (alive) setData((prev) => keepLastOnFailure(prev, { ok: true, data: next }).data);
          return null;
        })
        .catch((e: unknown) => {
          if (alive)
            setData(
              (prev) =>
                keepLastOnFailure(prev, {
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                }).data,
            );
        });
    void tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [list]);
  return data;
}

export function WindowBBand({ theme, open }: PluginWorkspaceBandProps) {
  const data = useBandData();
  const text = bandText(data);
  const c = theme.colors;
  const red = (data?.alerts ?? 0) > 0;
  const s = useMemo(
    () => ({
      band: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: c.surface1,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      },
      text: { fontSize: 12, color: red ? c.statusDanger : c.foregroundMuted },
    }),
    [c, red],
  );
  if (!text) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text}。押すと指示一覧を開く`}
      onPress={open}
      style={s.band}
    >
      <Text numberOfLines={1} style={s.text}>
        {text}
      </Text>
    </Pressable>
  );
}
