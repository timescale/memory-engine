/**
 * Tests for the interactive editor's pure helpers — specifically that `name`
 * round-trips so a rename/clear in `me memory edit` isn't silently dropped.
 */
import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../parsers/markdown.ts";
import { formatForEdit, hasChanges } from "./memory-edit.ts";

describe("formatForEdit", () => {
  test("emits the name in frontmatter when set, and it round-trips through the parser", () => {
    const text = formatForEdit({
      id: "0194a000-0001-7000-8000-000000000001",
      content: "body",
      name: "jwt-rotation",
      tree: "share.auth",
    });
    expect(text).toContain("name: jwt-rotation");
    const parsed = parseMarkdown(text)[0];
    expect(parsed?.name).toBe("jwt-rotation");
  });

  test("omits the name line for an unnamed memory", () => {
    const text = formatForEdit({
      id: "0194a000-0001-7000-8000-000000000001",
      content: "body",
      tree: "share.auth",
    });
    expect(text).not.toContain("name:");
  });
});

describe("hasChanges (name)", () => {
  const base = { content: "body", tree: "share.auth", name: "jwt-rotation" };

  test("detects a rename", () => {
    expect(hasChanges(base, { content: "body", name: "jwt-rotate" })).toBe(
      true,
    );
  });

  test("detects clearing the name (line removed)", () => {
    expect(hasChanges(base, { content: "body" })).toBe(true);
  });

  test("detects adding a name where there was none", () => {
    expect(
      hasChanges(
        { content: "body", tree: "share.auth" },
        { content: "body", tree: "share.auth", name: "jwt-rotation" },
      ),
    ).toBe(true);
  });

  test("no change when the name is untouched", () => {
    expect(
      hasChanges(base, {
        content: "body",
        tree: "share.auth",
        name: "jwt-rotation",
      }),
    ).toBe(false);
  });
});
