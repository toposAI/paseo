export const MAX_EXPLICIT_AGENT_TITLE_CHARS = 200;

/**
 * 題名の出どころを持つラベル。サイドバーの題名を LLM の自動要約で置き換えてよいかを
 * これだけで判定する(2026-10-26 ユーザー指示「サイドバーのスレ名は LLM が生成したものを出す」)。
 *
 * - `initial`: スレ作成時に付いた題名(`paseo run --title` や最初のプロンプト由来)。**置き換えてよい**。
 * - `auto`: 自動要約が書いた題名。**置き換えてよい**。
 * - `user`: 作成後に人が付けた題名(アプリの名前変更・`paseo agent update --name`)。**触らない**。
 *
 * ラベルが無いスレは、作成時の暫定題名と一致するときだけ置き換える(旧データの互換)。
 */
export const AGENT_TITLE_SOURCE_LABEL = "paseo.title-source";
export const AGENT_TITLE_SOURCE_AUTO = "auto";
export const AGENT_TITLE_SOURCE_INITIAL = "initial";
export const AGENT_TITLE_SOURCE_USER = "user";

/**
 * `1` を立てると、次のターン終了時(または起動時の付け直し)に、人が付けた題名でも
 * 一度だけ要約で置き換える。付け直しが済むと `done` になる。
 */
export const AGENT_TITLE_REGENERATE_LABEL = "paseo.title-regenerate";

/** `1` を立てたスレは、デーモン起動時に**一度だけ**題名を付け直す(既存スレの一括付け直し用)。 */
export const AGENT_TITLE_RETITLE_LABEL = "paseo.title-retitle";
