/**
 * Unit tests for memory import parsers.
 */
import { describe, expect, test } from "bun:test";
import { parseJson, parseMarkdown, parseYaml } from "./index.ts";

describe("memory import temporal parsing", () => {
  test("accepts YAML temporal objects emitted by export", () => {
    const memories = parseYaml(`
- content: Exported memory
  tree: notes
  temporal:
    start: "2024-01-01T00:00:00Z"
    end: "2024-01-02T00:00:00Z"
`);

    expect(memories).toEqual([
      {
        content: "Exported memory",
        tree: "notes",
        temporal: {
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-02T00:00:00Z",
        },
      },
    ]);
  });

  test("accepts start-only YAML temporal objects", () => {
    const memories = parseYaml(`
content: Start-only memory
temporal:
  start: "2024-01-01T00:00:00Z"
`);

    expect(memories).toEqual([
      {
        content: "Start-only memory",
        temporal: {
          start: "2024-01-01T00:00:00Z",
        },
      },
    ]);
  });

  test("accepts Markdown frontmatter temporal objects emitted by export", () => {
    const memories = parseMarkdown(`---
tree: notes
temporal:
  start: "2024-01-01T00:00:00Z"
  end: "2024-01-02T00:00:00Z"
---

Exported markdown memory
`);

    expect(memories).toEqual([
      {
        content: "Exported markdown memory",
        tree: "notes",
        temporal: {
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-02T00:00:00Z",
        },
      },
    ]);
  });
});

describe("memory import name parsing", () => {
  test("passes a filename-like name through JSON", () => {
    expect(
      parseJson('{"content":"x","tree":"share/auth","name":"jwt-rotation"}'),
    ).toEqual([{ content: "x", tree: "share/auth", name: "jwt-rotation" }]);
  });

  test("passes a name through YAML and Markdown frontmatter", () => {
    expect(parseYaml("content: x\nname: config.yaml\n")).toEqual([
      { content: "x", name: "config.yaml" },
    ]);
    expect(parseMarkdown("---\nname: README.md\n---\n\nbody\n")).toEqual([
      { content: "body", name: "README.md" },
    ]);
  });

  test("rejects names with a slash or other invalid characters", () => {
    expect(() => parseJson('{"content":"x","name":"a/b"}')).toThrow(
      /Invalid name/,
    );
    expect(() => parseJson('{"content":"x","name":".hidden"}')).toThrow(
      /Invalid name/,
    );
  });
});
