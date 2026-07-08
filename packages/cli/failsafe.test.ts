/**
 * Tests for the failsafe decision core (decideFailsafe) — the truth table
 * from HARNESS_DESIGN.md's "Enforcement by surface" (c) section. Supplies a
 * synthetic HarnessDetection rather than faking env vars, since that matrix
 * is covered separately in harness-detect.test.ts.
 */
import { expect, test } from "bun:test";
import { decideFailsafe, type FailsafeInputs } from "./failsafe.ts";

function inputs(overrides: Partial<FailsafeInputs> = {}): FailsafeInputs {
  return {
    commandPath: "memory search",
    env: {},
    hasExplicitAsAgent: false,
    hasAgentApiKey: false,
    isStderrTTY: false,
    ...overrides,
  };
}

test("no harness detected → ok (human terminal)", () => {
  expect(decideFailsafe(inputs(), { isAgent: false })).toEqual({
    action: "ok",
  });
});

test("allowlisted command → ok even with a detected harness", () => {
  expect(
    decideFailsafe(inputs({ commandPath: "mcp" }), {
      isAgent: true,
      agent: "codex",
    }),
  ).toEqual({ action: "ok" });
});

test("explicit --as-agent → ok even with a detected harness", () => {
  expect(
    decideFailsafe(inputs({ hasExplicitAsAgent: true }), {
      isAgent: true,
      agent: "codex",
    }),
  ).toEqual({ action: "ok" });
});

test("agent api key credential → ok even with a detected harness", () => {
  expect(
    decideFailsafe(inputs({ hasAgentApiKey: true }), {
      isAgent: true,
      agent: "codex",
    }),
  ).toEqual({ action: "ok" });
});

test("live injected contract → ok even with a detected harness", () => {
  expect(
    decideFailsafe(inputs({ env: { ME_INJECT_V: "1" } }), {
      isAgent: true,
      agent: "codex",
    }),
  ).toEqual({ action: "ok" });
});

test("detected harness, non-TTY, no injection → error naming the integrated install fix", () => {
  const verdict = decideFailsafe(inputs(), { isAgent: true, agent: "codex" });
  expect(verdict.action).toBe("error");
  expect((verdict as { message: string }).message).toContain(
    "me codex install",
  );
});

test("integrated-harness install hints cover every native/injected name", () => {
  for (const [agent, hint] of [
    ["claude", "me claude install"],
    ["cowork", "me claude install"],
    ["opencode", "me opencode install"],
    ["codex", "me codex install"],
    ["gemini", "me gemini install"],
    ["gemini-cli", "me gemini install"],
  ] as const) {
    const verdict = decideFailsafe(inputs(), { isAgent: true, agent });
    expect(verdict.action).toBe("error");
    expect((verdict as { message: string }).message).toContain(hint);
  }
});

test("real-world Claude Code AI_AGENT value (version-qualified, not the bare 'claude') still matches", () => {
  // Confirmed empirically: Claude Code sets AI_AGENT=claude-code_<version>_agent
  // in its own Bash tool env, not the literal detect-agent name "claude".
  const verdict = decideFailsafe(inputs(), {
    isAgent: true,
    agent: "claude-code_2-1-204_agent",
  });
  expect(verdict.action).toBe("error");
  expect((verdict as { message: string }).message).toContain(
    "me claude install",
  );
});

test("a harness-specific AI_AGENT value falls back to the raw native marker", () => {
  // AI_AGENT is checked first by detect-agent, so its value can shadow a
  // harness's own native marker with something unrecognizable by name alone.
  const verdict = decideFailsafe(inputs({ env: { CODEX_THREAD_ID: "t" } }), {
    isAgent: true,
    agent: "some-opaque-wrapper-name",
  });
  expect(verdict.action).toBe("error");
  expect((verdict as { message: string }).message).toContain(
    "me codex install",
  );
});

test("detected but unintegrated harness → error asking to file an issue, no install hint", () => {
  const verdict = decideFailsafe(inputs(), { isAgent: true, agent: "cursor" });
  expect(verdict.action).toBe("error");
  const message = (verdict as { message: string }).message;
  expect(message).toContain("file a GitHub issue");
  expect(message).not.toContain("install");
});

test("detected harness, non-TTY, no agent name at all → the unintegrated-harness error", () => {
  const verdict = decideFailsafe(inputs(), { isAgent: true });
  expect(verdict.action).toBe("error");
  expect((verdict as { message: string }).message).toContain(
    "file a GitHub issue",
  );
});

test("interactive stderr TTY → notice, not error (IDE integrated terminal exemption)", () => {
  const verdict = decideFailsafe(inputs({ isStderrTTY: true }), {
    isAgent: true,
    agent: "claude",
  });
  expect(verdict.action).toBe("notice");
  expect((verdict as { message: string }).message).toContain("claude");
});

test("TTY exemption applies even for an unintegrated harness", () => {
  const verdict = decideFailsafe(inputs({ isStderrTTY: true }), {
    isAgent: true,
    agent: "cursor",
  });
  expect(verdict.action).toBe("notice");
});
