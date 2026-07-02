/**
 * Tests for the canonical integration asset renderers (`agent/assets.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  ASSET_MARKER,
  meInvocation,
  RECALL_SKILL_NAME,
  renderClaudeImportSnippet,
  renderProjectContextSnippet,
  renderRecallCommand,
  renderRecallSkill,
  renderSkill,
  renderUserContextSnippet,
  SKILL_NAME,
} from "./assets.ts";
import { hasBlock, markdownMarkers } from "./managed.ts";

describe("meInvocation", () => {
  test("user scope → plain me; project scope → --as-agent .me", () => {
    expect(meInvocation({ agentMode: false })).toBe("me");
    expect(meInvocation({ agentMode: true })).toBe("me --as-agent .me");
  });
});

describe("renderSkill", () => {
  test("carries the scope-neutral managed marker + skill name", () => {
    const md = renderSkill({ agentMode: false });
    expect(md).toContain(ASSET_MARKER);
    expect(md).toContain(`name: ${SKILL_NAME}`);
  });

  test("skill name is a valid skill identifier", () => {
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(RECALL_SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("project scope embeds --as-agent .me in CLI examples; user does not", () => {
    expect(renderSkill({ agentMode: true })).toContain(
      'me --as-agent .me search "<query>"',
    );
    const user = renderSkill({ agentMode: false });
    expect(user).toContain('me search "<query>"');
    expect(user).not.toContain("--as-agent");
  });
});

describe("renderRecallCommand / renderRecallSkill", () => {
  test("command defaults to $ARGUMENTS and carries the marker", () => {
    const md = renderRecallCommand();
    expect(md).toContain(ASSET_MARKER);
    expect(md).toContain("relevant to: $ARGUMENTS");
    expect(md).toContain("me_memory_search");
  });

  test("command accepts a harness-specific args placeholder", () => {
    expect(renderRecallCommand({ argsPlaceholder: "{{args}}" })).toContain(
      "relevant to: {{args}}",
    );
  });

  test("recall skill shares the prompt body", () => {
    const md = renderRecallSkill();
    expect(md).toContain(`name: ${RECALL_SKILL_NAME}`);
    expect(md).toContain(ASSET_MARKER);
    expect(md).toContain("me_memory_search");
  });
});

describe("context snippets", () => {
  test("user variant carries the `me install` marker and no identity facts", () => {
    const s = renderUserContextSnippet();
    expect(hasBlock(s, markdownMarkers("me install"))).toBe(true);
    expect(s).toContain("me_memory_search");
    expect(s).not.toContain("--as-agent");
    expect(s).not.toContain("agent");
  });

  test("project variant is harness-agnostic (`me init` marker) and templated", () => {
    const s = renderProjectContextSnippet({
      projectTree: "share.projects.foo",
      space: "abc123",
      agentMode: true,
    });
    expect(hasBlock(s, markdownMarkers("me init"))).toBe(true);
    expect(s).toContain("    share.projects.foo");
    expect(s).toContain("`share.projects.foo.agent_sessions`");
    expect(s).toContain("`share.projects.foo.git_history`");
    expect(s).toContain("space `abc123`");
    expect(s).toContain("ME_AS_AGENT=.me");
    expect(s).toContain('me --as-agent .me search "<query>"');
  });

  test("project variant without agent mode omits the identity lines", () => {
    const s = renderProjectContextSnippet({
      projectTree: "share.projects.foo",
      agentMode: false,
    });
    expect(s).not.toContain("ME_AS_AGENT");
    expect(s).toContain('me search "<query>"');
  });

  test("rendering is deterministic (byte-identical for identical facts)", () => {
    const facts = { projectTree: "share.projects.x", agentMode: true };
    expect(renderProjectContextSnippet(facts)).toBe(
      renderProjectContextSnippet(facts),
    );
  });

  test("claude bridge variant imports AGENTS.md under the shared marker", () => {
    const s = renderClaudeImportSnippet();
    expect(hasBlock(s, markdownMarkers("me init"))).toBe(true);
    expect(s).toContain("@AGENTS.md");
  });
});
