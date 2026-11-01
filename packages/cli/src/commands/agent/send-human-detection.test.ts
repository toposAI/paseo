import { afterEach, expect, test } from "vitest";
import { isHumanAtTerminal } from "./send.js";

const originalIn = process.stdin.isTTY;
const originalOut = process.stdout.isTTY;
const originalAgentId = process.env.PASEO_AGENT_ID;

afterEach(() => {
  process.stdin.isTTY = originalIn;
  process.stdout.isTTY = originalOut;
  if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = originalAgentId;
});

function setup(stdin: boolean, stdout: boolean, agentId?: string) {
  process.stdin.isTTY = stdin;
  process.stdout.isTTY = stdout;
  if (agentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = agentId;
}

test("a person at a terminal is human", () => {
  setup(true, true);
  expect(isHumanAtTerminal()).toBe(true);
});

test("a launchd job or script (no TTY) is automation", () => {
  setup(false, false);
  expect(isHumanAtTerminal()).toBe(false);
});

test("captured output (agent tool / subprocess) is automation", () => {
  setup(true, false);
  expect(isHumanAtTerminal()).toBe(false);
});

test("inside an agent, even with a TTY, is automation", () => {
  setup(true, true, "agent-1");
  expect(isHumanAtTerminal()).toBe(false);
});
