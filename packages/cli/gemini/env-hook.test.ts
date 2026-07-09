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

test("first-writer-wins: emits nothing when the contract is already live", () => {
  const result = buildGeminiEnvHookOutput(VALID_PAYLOAD, {
    ME_INJECT_V: "1",
    ME_AS_AGENT: ".me",
    ME_PROJECT_DIR: "/other/project",
  });
  expect(result).toEqual({});
});

test("a PARTIALLY live contract (ME_INJECT_V alone) does NOT trigger first-writer-wins", () => {
  const result = buildGeminiEnvHookOutput(VALID_PAYLOAD, { ME_INJECT_V: "1" });
  expect(result.output).toBeDefined();
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

test("the rewritten command, when actually executed by a real shell, sets the env vars", async () => {
  // Gemini CLI's own side of the contract is running the rewritten
  // tool_input.command through its own shell exec — we don't control or
  // test that (it's Gemini's own behavior), but the rewritten STRING is
  // entirely ours, and there's no other harness-specific step left:
  // running it via a real shell IS the mechanism. Use `env` as the
  // "original command" so the executed process reveals its own environment.
  const result = buildGeminiEnvHookOutput(
    { ...VALID_PAYLOAD, tool_input: { command: "env" } },
    {},
  );
  const command = (
    result.output?.hookSpecificOutput as { tool_input: { command: string } }
  ).tool_input.command;

  const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);

  const env: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx !== -1) env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  expect(env.ME_INJECT_V).toBe("1");
  expect(env.AI_AGENT).toBe("gemini-cli");
  expect(env.ME_AS_AGENT).toBe(".me");
  expect(env.ME_PROJECT_DIR).toBe("/repo/project");
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
