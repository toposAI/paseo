import { afterEach, expect, test } from "vitest";
import { isHumanAtTerminal } from "./send.js";

const originalErr = process.stderr.isTTY;
const originalOut = process.stdout.isTTY;
const originalAgentId = process.env.PASEO_AGENT_ID;

afterEach(() => {
  process.stderr.isTTY = originalErr;
  process.stdout.isTTY = originalOut;
  if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = originalAgentId;
});

function setup(stdout: boolean, stderr: boolean, agentId?: string) {
  process.stdout.isTTY = stdout;
  process.stderr.isTTY = stderr;
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

test("a person piping stdout (| jq) with stderr on the terminal is still human", () => {
  setup(false, true);
  expect(isHumanAtTerminal()).toBe(true);
});

test("inside an agent, even with a TTY, is automation", () => {
  setup(true, true, "agent-1");
  expect(isHumanAtTerminal()).toBe(false);
});
