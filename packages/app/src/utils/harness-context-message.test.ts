import { describe, expect, it } from "vitest";
import { isHarnessContextOnlyMessage } from "./harness-context-message";

// Shape of a user turn Claude Code wrote after compaction: reminders, the environment
// update, and a Read tool record, with no words of the user's own.
const COMPACTED_TURN = `> <system-reminder> Attribution for git commits and pull requests you create from here on:
>
> - End git commit messages with: Co-Authored-By: Claude Sonnet 5.5 [noreply@anthropic.com](mailto:noreply@anthropic.com)
> - End pull request descriptions with: 🤖 Generated with [Claude Code](https://claude.com/claude-code) </system-reminder># Environment update
> - Primary working directory: /Users/user/repos/example/.claude-memory (was /Users/user/repos/example)
>
> <total\\_tokens>14998593 tokens left</total\\_tokens>
>
> Called the Read tool with the following input: {"file\\_path":"/Users/user/.claude/projects/example/memory/feedback\\_example.md"} Result of calling the Read tool: 1 --- 2 name: feedback-example 3 ---`;

const REMINDER_ONLY_TURN =
  "> <system-reminder> Attribution for git commits and pull requests you create from here on: Co-Authored-By: Claude Code </system-reminder># Environment update\n> - Primary working directory: /Users/user/repos/example\n> \n> <total\\_tokens>14998593 tokens left</total\\_tokens>";

describe("isHarnessContextOnlyMessage", () => {
  it("folds a compacted turn whose trailing words were not persisted", () => {
    expect(isHarnessContextOnlyMessage(COMPACTED_TURN)).toBe(true);
  });

  it("folds reminders plus an environment update", () => {
    expect(isHarnessContextOnlyMessage(REMINDER_ONLY_TURN)).toBe(true);
  });

  it("folds a bare total_tokens reminder", () => {
    expect(
      isHarnessContextOnlyMessage(
        "<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>",
      ),
    ).toBe(true);
  });

  it("keeps a message that adds words of its own to a reminder", () => {
    expect(
      isHarnessContextOnlyMessage(
        `${COMPACTED_TURN}\n\nなんかこんな感じの文字列が表示されているんだけど`,
      ),
    ).toBe(false);
    expect(isHarnessContextOnlyMessage(`${REMINDER_ONLY_TURN}\n\nこの表示を消したい`)).toBe(false);
    expect(
      isHarnessContextOnlyMessage(
        "<system-reminder>All background tasks are complete.</system-reminder>\nExplain this output",
      ),
    ).toBe(false);
  });

  it("does not fold a plain tool output", () => {
    expect(
      isHarnessContextOnlyMessage(
        '> Called the Read tool with the following input: {"file_path":"/tmp/a.ts"} Result of calling the Read tool: export const a = 1;',
      ),
    ).toBe(false);
  });

  it("treats a message that only quotes a reply as user content", () => {
    expect(isHarnessContextOnlyMessage("> 返信しました\n> ありがとう")).toBe(false);
  });

  it("leaves ordinary messages alone", () => {
    expect(isHarnessContextOnlyMessage("このスレ、今日どうする?")).toBe(false);
    expect(isHarnessContextOnlyMessage("")).toBe(false);
  });
});
