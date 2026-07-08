/**
 * Tests for the Codex PreToolUse env-hook decision core.
 */
import { expect, test } from "bun:test";
import { buildCodexEnvHookOutput } from "./env-hook.ts";

const VALID_PAYLOAD = {
  session_id: "sess_1",
  cwd: "/repo/project",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: "tu_1",
  tool_input: { command: "npm test" },
};

test("rewrites a Bash command with the export prefix", () => {
  const result = buildCodexEnvHookOutput(VALID_PAYLOAD, {});
  expect(result.unrecognizedShape).toBeUndefined();
  expect(result.output).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        command:
          'export ME_INJECT_V="1" AI_AGENT="codex" ME_AS_AGENT=".me" ME_PROJECT_DIR="/repo/project"; npm test',
      },
    },
  });
});

test("first-writer-wins: emits nothing when ME_INJECT_V is already live", () => {
  const result = buildCodexEnvHookOutput(VALID_PAYLOAD, { ME_INJECT_V: "1" });
  expect(result).toEqual({});
});

test("expected non-match: a non-Bash tool call emits nothing, no log", () => {
  const result = buildCodexEnvHookOutput(
    { ...VALID_PAYLOAD, tool_name: "apply_patch" },
    {},
  );
  expect(result).toEqual({});
});

test("unrecognized shape: not an object at all", () => {
  expect(buildCodexEnvHookOutput("not an object", {})).toEqual({
    unrecognizedShape: true,
  });
  expect(buildCodexEnvHookOutput(null, {})).toEqual({
    unrecognizedShape: true,
  });
  expect(buildCodexEnvHookOutput([1, 2], {})).toEqual({
    unrecognizedShape: true,
  });
});

test("unrecognized shape: missing cwd", () => {
  const { cwd, ...rest } = VALID_PAYLOAD;
  expect(buildCodexEnvHookOutput(rest, {})).toEqual({
    unrecognizedShape: true,
  });
});

test("unrecognized shape: missing tool_name", () => {
  const { tool_name, ...rest } = VALID_PAYLOAD;
  expect(buildCodexEnvHookOutput(rest, {})).toEqual({
    unrecognizedShape: true,
  });
});

test("unrecognized shape: tool_input.command is not a string", () => {
  expect(
    buildCodexEnvHookOutput(
      { ...VALID_PAYLOAD, tool_input: { command: ["npm", "test"] } },
      {},
    ),
  ).toEqual({ unrecognizedShape: true });
});

test("unrecognized shape: tool_input missing entirely", () => {
  const { tool_input, ...rest } = VALID_PAYLOAD;
  expect(buildCodexEnvHookOutput(rest, {})).toEqual({
    unrecognizedShape: true,
  });
});

test("a project dir with shell-special characters is safely quoted", () => {
  const result = buildCodexEnvHookOutput(
    { ...VALID_PAYLOAD, cwd: `/repo/it's a "test"` },
    {},
  );
  const command = (
    result.output?.hookSpecificOutput as { updatedInput: { command: string } }
  ).updatedInput.command;
  expect(command).toContain('ME_PROJECT_DIR="/repo/it\'s a \\"test\\""');
  expect(command.endsWith("; npm test")).toBe(true);
});
