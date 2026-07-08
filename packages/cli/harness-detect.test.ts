/**
 * Tests for detectHarness(): the @vercel/detect-agent wrapper plus our own
 * OPENCODE=1 / AGENT=1 backstop for opencode's terminal-launched CLI/TUI path
 * (stock detect-agent only checks OPENCODE_CLIENT).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { detectHarness } from "./harness-detect.ts";

const HARNESS_ENV_VARS = [
  "AI_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "REPL_ID",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
  "OPENCODE",
  "AGENT",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of HARNESS_ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of HARNESS_ENV_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("no markers → not an agent", async () => {
  expect(await detectHarness()).toEqual({ isAgent: false });
});

test("CLAUDECODE=1 → claude", async () => {
  process.env.CLAUDECODE = "1";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "claude" });
});

test("GEMINI_CLI=1 → gemini", async () => {
  process.env.GEMINI_CLI = "1";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "gemini" });
});

test("CODEX_THREAD_ID → codex", async () => {
  process.env.CODEX_THREAD_ID = "thread_abc";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "codex" });
});

test("OPENCODE_CLIENT → opencode (stock detect-agent path)", async () => {
  process.env.OPENCODE_CLIENT = "desktop";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "opencode" });
});

test("OPENCODE=1 alone (terminal CLI path) → opencode via our backstop", async () => {
  process.env.OPENCODE = "1";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "opencode" });
});

test("AGENT=1 alone → opencode via our backstop", async () => {
  process.env.AGENT = "1";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "opencode" });
});

test("AI_AGENT convention wins first, even over other markers", async () => {
  process.env.AI_AGENT = "claude";
  process.env.GEMINI_CLI = "1";
  expect(await detectHarness()).toEqual({ isAgent: true, agent: "claude" });
});

test("our injected AI_AGENT=gemini-cli passes through verbatim", async () => {
  process.env.AI_AGENT = "gemini-cli";
  expect(await detectHarness()).toEqual({
    isAgent: true,
    agent: "gemini-cli",
  });
});
