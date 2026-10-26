import { describe, expect, test } from "vitest";
import { AGENT_TITLE_SOURCE_LABEL } from "@getpaseo/protocol/agent-title-limits";
import {
  resolveCreateAgentTitles,
  withInitialTitleSource,
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
});
