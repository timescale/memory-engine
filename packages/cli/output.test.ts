/**
 * Unit tests for output formatting helpers.
 *
 * Focused on the columnar `table()` renderer's resilience to embedded
 * control characters (TNT-153: `me search` previews containing newlines
 * used to break column alignment).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { setExpanded, table } from "./output.ts";

/** Run `fn`, capturing every `console.log` line it emits. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("table()", () => {
  afterEach(() => {
    // `setExpanded` mutates module-level state; reset between tests.
    setExpanded(false);
  });

  test("emits exactly one physical line per row plus header and separator", () => {
    const lines = capture(() => {
      table(
        ["id", "content"],
        [
          ["1", "hello"],
          ["2", "world"],
        ],
      );
    });
    // header + separator + 2 rows
    expect(lines).toHaveLength(4);
  });

  test("a cell containing newlines does not break onto extra lines", () => {
    const lines = capture(() => {
      table(
        ["id", "content", "tree", "score"],
        [
          [
            "abc",
            "# SQL Style Guide\n## Keywords and Identifiers",
            "/share",
            "0.028",
          ],
        ],
      );
    });
    // header + separator + exactly one row line (no spill from the newline)
    expect(lines).toHaveLength(3);
    const row = lines[2] ?? "";
    expect(row).not.toContain("\n");
    // The newline became a space, and the trailing columns stay on the row.
    expect(row).toContain("# SQL Style Guide ## Keywords and Identifiers");
    expect(row).toContain("/share");
    expect(row).toContain("0.028");
  });

  test("carriage returns and tabs are also collapsed to a single space", () => {
    const lines = capture(() => {
      table(["a", "b"], [["x\r\ny\tz", "end"]]);
    });
    const row = lines[2] ?? "";
    expect(row).not.toMatch(/[\r\n\t]/);
    expect(row).toContain("x y z");
    expect(row).toContain("end");
  });

  test("column alignment is preserved across rows with and without newlines", () => {
    const lines = capture(() => {
      table(
        ["id", "content", "score"],
        [
          ["1", "plain", "0.9"],
          ["2", "multi\nline", "0.8"],
        ],
      );
    });
    expect(lines).toHaveLength(4);
    const row1 = lines[2] ?? "";
    const row2 = lines[3] ?? "";
    // The last column ("score") must begin at the same column index in both
    // rows — i.e. the embedded newline did not shift alignment.
    expect(row1.indexOf("0.9")).toBe(row2.indexOf("0.8"));
  });

  test("expanded mode collapses newlines in field values", () => {
    setExpanded(true);
    const lines = capture(() => {
      table(["id", "content"], [["abc", "line1\nline2"]]);
    });
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
    expect(lines.some((l) => l.includes("line1 line2"))).toBe(true);
  });
});
