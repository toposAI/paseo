/** 共有プロジェクトの各画面(スレッド・ノート・概要とメンバー)が受け取る共通の入り口。 */
import type { ProjectConfig, ProjectDetail } from "../../shared/shared-projects-api.js";
import type { CallApi } from "./api.js";
import type { Colors, S } from "./ui.js";

export type OpenScreen = (input: { screenId: string; params?: Record<string, string> }) => void;

export interface ProjectCtx {
  s: S;
  colors: Colors;
  call: CallApi;
  id: string;
  detail: ProjectDetail | null;
  /** 自分のユーザーID(スレッド取得で分かる。未取得は空)。 */
  me: string;
  /** Topos の /config。旧鍵(範囲が狭い鍵)では取れず null。 */
  config: ProjectConfig | null;
  /** 旧鍵(宛先・添付・AI・ノートなどが使えない鍵)と判明した。 */
  limited: boolean;
  writable: boolean;
  creator: boolean;
  reloadDetail: () => Promise<void>;
  openScreen: OpenScreen;
}
