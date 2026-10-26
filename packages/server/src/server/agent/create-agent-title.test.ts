import { describe, expect, test } from "vitest";
import {
  AGENT_TITLE_REGENERATE_LABEL,
  AGENT_TITLE_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-title-limits";
import {
  resolveCreateAgentTitles,
  withInitialTitleSource,
  withRenameTitleSource,
  withUserTitleSource,
} from "./create-agent-title.js";

describe("resolveCreateAgentTitles", () => {
  test("explicit title wins over the prompt copy", () => {
    const titles = resolveCreateAgentTitles({
      configTitle: "窓口B",
      initialPrompt: "あなたは受付担当です\n本文",
    });
    expect(titles).toEqual({ explicitTitle: "窓口B", provisionalTitle: "窓口B" });
  });
});

describe("title source labels", () => {
  test("creation marks the title replaceable", () => {
    expect(withInitialTitleSource(undefined)).toEqual({
      [AGENT_TITLE_SOURCE_LABEL]: "initial",
    });
    expect(withInitialTitleSource({ keep: "me" })).toEqual({
      keep: "me",
      [AGENT_TITLE_SOURCE_LABEL]: "initial",
    });
  });

  test("an explicit title source from the caller is preserved (--label paseo.title-source=user)", () => {
    expect(withInitialTitleSource({ [AGENT_TITLE_SOURCE_LABEL]: "user" })).toEqual({
      [AGENT_TITLE_SOURCE_LABEL]: "user",
    });
    expect(withUserTitleSource({ [AGENT_TITLE_SOURCE_LABEL]: "auto" })).toEqual({
      [AGENT_TITLE_SOURCE_LABEL]: "auto",
    });
  });

  test("a later rename is user-owned", () => {
    expect(withUserTitleSource(undefined)).toEqual({ [AGENT_TITLE_SOURCE_LABEL]: "user" });
    expect(withUserTitleSource({ keep: "me" })).toEqual({
      keep: "me",
      [AGENT_TITLE_SOURCE_LABEL]: "user",
    });
  });

  // 回帰: 改名と一緒に付け直しを頼んだのに `user` が付き、自分で自分をブロックしていた(2026-10-27 出口レビュー指摘4)。
  test("a rename that also asks for a regenerate is not locked as user", () => {
    expect(withRenameTitleSource({ [AGENT_TITLE_REGENERATE_LABEL]: "1" })).toEqual({
      [AGENT_TITLE_REGENERATE_LABEL]: "1",
    });
    expect(withRenameTitleSource(undefined)).toEqual({ [AGENT_TITLE_SOURCE_LABEL]: "user" });
    expect(withRenameTitleSource({ [AGENT_TITLE_SOURCE_LABEL]: "auto" })).toEqual({
      [AGENT_TITLE_SOURCE_LABEL]: "auto",
    });
  });
});
