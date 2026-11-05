/**
 * 「UIの最終チェック」カードを順に片付ける状態(純粋な規則は `shared/ufc-flow.ts`)。
 * 見ているカード・返事待ち・未読の印を持ち、一覧が変わったら(OK で消えた等)つじつまを合わせる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  UFC_FLOW_EMPTY,
  afterReply,
  afterSent,
  applyMarks,
  reconcile,
  select,
  skipToNext,
  ufcCounts,
} from "../shared/ufc-flow.js";
import type { UfcFlow, UfcMarks } from "../shared/ufc-flow.js";

/**
 * @param ids 一覧に出す UFC カード(絞り込みで隠れても消さない=呼び出し側が全件を渡す)
 * @param marks サーバの ask 台帳から来た印(返事待ち・未読)。取り直すたびに上書きする。
 */
export function useUfcFlow(ids: readonly string[], marks: UfcMarks = {}) {
  const [flow, setFlow] = useState<UfcFlow>(UFC_FLOW_EMPTY);
  // 一度でも見たカードは、離れても会話(下書き・返事)を保つため入力欄を載せたままにする。
  const [visited, setVisited] = useState<readonly string[]>([]);
  const [everHad, setEverHad] = useState(false);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const prevIds = useRef<readonly string[]>([]);
  const idsKey = ids.join("|");
  const marksKey = ids
    .map((id) => `${id}:${marks[id]?.waiting ? 1 : 0}${marks[id]?.unread ? 1 : 0}`)
    .join("|");

  useEffect(() => {
    setFlow((f) => reconcile(f, prevIds.current, idsRef.current));
    prevIds.current = idsRef.current;
    if (idsRef.current.length > 0) setEverHad(true);
  }, [idsKey]);

  // 台帳の印を重ねる。ここが返事待ち・未読の正で、画面のメモリは一覧を取り直すまでのつなぎ。
  useEffect(() => {
    setFlow((f) => applyMarks(f, idsRef.current, marksRef.current));
  }, [marksKey]);

  const { current } = flow;
  useEffect(() => {
    if (current) setVisited((v) => (v.includes(current) ? v : [...v, current]));
  }, [current]);

  const sent = useCallback((id: string) => setFlow((f) => afterSent(f, idsRef.current, id)), []);
  const replied = useCallback((id: string) => setFlow((f) => afterReply(f, id)), []);
  const choose = useCallback((id: string) => setFlow((f) => select(f, id)), []);
  const skip = useCallback(() => setFlow((f) => skipToNext(f, idsRef.current)), []);
  const counts = useMemo(() => ufcCounts(ids, flow), [ids, flow]);
  return { flow, visited, everHad, counts, sent, replied, choose, skip };
}
