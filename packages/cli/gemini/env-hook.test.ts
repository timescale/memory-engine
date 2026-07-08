/**
 * Tests for the Gemini CLI BeforeTool env-hook decision core.
 */
import { expect, test } from "bun:test";
import { buildGeminiEnvHookOutput } from "./env-hook.ts";

const VALID_PAYLOAD = {
  session_id: "sess_1",
  cwd: "/repo/project",
  hook_event_name: "BeforeTool",
  tool_name: "run_shell_command",
  tool_input: { command: "npm test" },
};

test("rewrites a run_shell_command with the export prefix", () => {
  const result = buildGeminiEnvHookOutput(VALID_PAYLOAD, {});
  expect(result.unrecognizedShape).toBeUndefined();
  expect(result.output).toEqual({
    hookSpecificOutput: {
      tool_input: {
        command:
          'export ME_INJECT_V="1" AI_AGENT="gemini-cli" ME_AS_AGENT=".me" ME_PROJECT_DIR="/repo/project"; npm test',
      },
    },
  });
});

test("first-writer-wins: emits nothing when ME_INJECT_V is already live", () => {
  const result = buildGeminiEnvHookOutput(VALID_PAYLOAD, { ME_INJECT_V: "1" });
  expect(result).toEqual({});
});

test("expected non-match: a non-shell tool call emits nothing, no log", () => {
  const result = buildGeminiEnvHookOutput(
    { ...VALID_PAYLOAD, tool_name: "read_file" },
    {},
  );
  expect(result).toEqual({});
});

test("unrecognized shape: not an object at all", () => {
  expect(buildGeminiEnvHookOutput("not an object", {})).toEqual({
    unrecognizedShape: true,
  });
  expect(buildGeminiEnvHookOutput(undefined, {})).toEqual({
    unrecognizedShape: true,
  });
});

test("unrecognized shape: missing cwd", () => {
  const { cwd, ...rest } = VALID_PAYLOAD;
  expect(buildGeminiEnvHookOutput(rest, {})).toEqual({
    unrecognizedShape: true,
  });
});

test("unrecognized shape: tool_input.command is not a string", () => {
  expect(
    buildGeminiEnvHookOutput(
      { ...VALID_PAYLOAD, tool_input: { command: 42 } },
      {},
    ),
  ).toEqual({ unrecognizedShape: true });
});

test("a command containing shell-special characters passes through unescaped after the prefix", () => {
  const result = buildGeminiEnvHookOutput(
    { ...VALID_PAYLOAD, tool_input: { command: `echo "$HOME"` } },
    {},
  );
  const command = (
    result.output?.hookSpecificOutput as { tool_input: { command: string } }
  ).tool_input.command;
  expect(command.endsWith('; echo "$HOME"')).toBe(true);
});
