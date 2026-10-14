import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { claudeProjectDirSync } from "./project-dir.js";
import {
  isNonAnthropicEndpoint,
  stripDeferredToolsDelta,
  stripDeferredToolsDeltaFromTranscript,
} from "./transcript-provider-switch.js";

const line = (value: unknown) => JSON.stringify(value);

const transcript = [
  line({ uuid: "a", parentUuid: null, type: "attachment", attachment: { type: "hook_success" } }),
  line({
    uuid: "b",
    parentUuid: "a",
    type: "attachment",
    attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch"] },
  }),
  line({
    uuid: "c",
    parentUuid: "b",
    type: "attachment",
    attachment: { type: "deferred_tools_delta", addedNames: ["Monitor"] },
  }),
  line({ uuid: "d", parentUuid: "c", type: "user", message: { role: "user", content: "合言葉" } }),
  line({
    uuid: "e",
    parentUuid: "d",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "了解" }] },
  }),
].join("\n");

describe("stripDeferredToolsDelta", () => {
  test("drops deferred_tools_delta entries and re-links the parent chain, keeping conversation", () => {
    const { content, removed } = stripDeferredToolsDelta(transcript);
    const entries = content.split("\n").map((l) => JSON.parse(l));
    expect(removed).toBe(2);
    expect(entries.map((e) => e.uuid)).toEqual(["a", "d", "e"]);
    expect(entries.find((e) => e.uuid === "d").parentUuid).toBe("a");
    expect(entries.find((e) => e.uuid === "e").parentUuid).toBe("d");
    expect(entries.find((e) => e.uuid === "d").message.content).toBe("合言葉");
  });

  test("re-links to null when the dropped entry was the root", () => {
    const rootDelta = [
      line({
        uuid: "x",
        parentUuid: null,
        type: "attachment",
        attachment: { type: "deferred_tools_delta" },
      }),
      line({ uuid: "y", parentUuid: "x", type: "user", message: { role: "user", content: "hi" } }),
    ].join("\n");
    const { content } = stripDeferredToolsDelta(rootDelta);
    expect(JSON.parse(content).parentUuid).toBeNull();
  });

  test("leaves content without the marker untouched", () => {
    const plain = line({ uuid: "a", parentUuid: null, type: "user" });
    expect(stripDeferredToolsDelta(plain)).toEqual({ content: plain, removed: 0 });
  });

  test("does not drop an ordinary message that merely mentions the marker", () => {
    const mention = line({
      uuid: "a",
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "what is deferred_tools_delta?" },
    });
    expect(stripDeferredToolsDelta(mention)).toEqual({ content: mention, removed: 0 });
  });
});

describe("isNonAnthropicEndpoint", () => {
  test.each([
    [{}, false],
    [{ ANTHROPIC_BASE_URL: "" }, false],
    [{ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, false],
    [{ ANTHROPIC_BASE_URL: "http://127.0.0.1:8990/deepseek" }, true],
    [{ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" }, true],
    [{ ANTHROPIC_BASE_URL: "not a url" }, true],
  ])("%j -> %s", (env, expected) => {
    expect(isNonAnthropicEndpoint(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("stripDeferredToolsDeltaFromTranscript", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test("rewrites the transcript on disk and is a no-op the second time", async () => {
    const root = await mkdtemp(join(tmpdir(), "transcript-switch-"));
    dirs.push(root);
    const configDir = join(root, "claude");
    const cwd = join(root, "work");
    await mkdir(cwd, { recursive: true });
    const projectDir = claudeProjectDirSync(cwd, { configDir });
    await mkdir(projectDir, { recursive: true });
    const file = join(projectDir, "sess-1.jsonl");
    await writeFile(file, transcript);

    expect(
      await stripDeferredToolsDeltaFromTranscript({ cwd, sessionId: "sess-1", configDir }),
    ).toBe(2);
    const after = await readFile(file, "utf8");
    expect(after).not.toContain("deferred_tools_delta");
    expect(after).toContain("合言葉");
    expect(
      await stripDeferredToolsDeltaFromTranscript({ cwd, sessionId: "sess-1", configDir }),
    ).toBe(0);
  });

  test("a missing transcript is not an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "transcript-switch-"));
    dirs.push(root);
    expect(
      await stripDeferredToolsDeltaFromTranscript({
        cwd: root,
        sessionId: "nope",
        configDir: join(root, "claude"),
      }),
    ).toBe(0);
  });
});
