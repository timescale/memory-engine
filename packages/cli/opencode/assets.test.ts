/**
 * Tests for the OpenCode asset templates (recall command + skill).
 */
import { describe, expect, test } from "bun:test";
import {
  ASSET_MARKER,
  renderRecallCommand,
  renderSkill,
  SKILL_NAME,
} from "./assets.ts";

describe("renderRecallCommand", () => {
  test("has a description frontmatter and the $ARGUMENTS placeholder", () => {
    const md = renderRecallCommand();
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("description:");
    expect(md).toContain("$ARGUMENTS");
    expect(md).toContain("me_memory_search");
  });

  test("carries the managed marker for idempotent re-init", () => {
    expect(renderRecallCommand()).toContain(ASSET_MARKER);
  });
});

describe("renderSkill", () => {
  test("frontmatter name matches the skill dir name and is valid", () => {
    const md = renderSkill();
    expect(md).toContain(`name: ${SKILL_NAME}`);
    // OpenCode skill name rule: lowercase alphanumeric, single-hyphen separated.
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("has a description and the managed marker", () => {
    const md = renderSkill();
    expect(md).toContain("description:");
    expect(md).toContain(ASSET_MARKER);
    expect(md).toContain("me_memory_search");
  });
});
