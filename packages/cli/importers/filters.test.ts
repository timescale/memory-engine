/**
 * Tests for importer skip/filter helpers.
 */
import { describe, expect, test } from "bun:test";
import {
  filterBySessionShape,
  isTempCwd,
  matchesProjectFilter,
  matchesTimeWindow,
} from "./filters.ts";
import type { ImporterOptions } from "./types.ts";

function baseOptions(
  overrides: Partial<ImporterOptions> = {},
): ImporterOptions {
  return {
    fullTranscript: false,
    includeSidechains: false,
    includeTempCwd: false,
    includeTrivial: false,
    ...overrides,
  };
}

describe("isTempCwd", () => {
  test("detects macOS private temp folders", () => {
    expect(isTempCwd("/private/var/folders/abc/x/T")).toBe(true);
    expect(isTempCwd("/var/folders/abc/x/T")).toBe(true);
  });

  test("detects plain /tmp paths", () => {
    expect(isTempCwd("/tmp")).toBe(true);
    expect(isTempCwd("/tmp/something")).toBe(true);
    expect(isTempCwd("/private/tmp/something")).toBe(true);
  });

  test("rejects non-temp paths", () => {
    expect(isTempCwd("/Users/test/project")).toBe(false);
    expect(isTempCwd(undefined)).toBe(false);
  });
});

describe("matchesProjectFilter", () => {
  test("matches exact path", () => {
    expect(
      matchesProjectFilter("/Users/test/project", "/Users/test/project"),
    ).toBe(true);
  });

  test("matches descendants", () => {
    expect(
      matchesProjectFilter("/Users/test/project/sub", "/Users/test/project"),
    ).toBe(true);
  });

  test("rejects sibling paths", () => {
    expect(
      matchesProjectFilter("/Users/test/project-other", "/Users/test/project"),
    ).toBe(false);
  });

  test("no filter matches everything", () => {
    expect(matchesProjectFilter("/any/path", undefined)).toBe(true);
    expect(matchesProjectFilter(undefined, undefined)).toBe(true);
  });
});

describe("matchesTimeWindow", () => {
  test("accepts timestamps inside the window", () => {
    const res = matchesTimeWindow(
      "2026-06-15T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-12-31T23:59:59Z",
    );
    expect(res.ok).toBe(true);
  });

  test("rejects before --since", () => {
    const res = matchesTimeWindow(
      "2025-12-31T00:00:00Z",
      "2026-01-01T00:00:00Z",
      undefined,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("since_filter");
  });

  test("rejects after --until", () => {
    const res = matchesTimeWindow(
      "2027-01-01T00:00:00Z",
      undefined,
      "2026-12-31T23:59:59Z",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("until_filter");
  });
});

describe("filterBySessionShape", () => {
  const baseSession = {
    startedAt: "2026-04-01T10:00:00Z",
    messageCounts: { user: 5, assistant: 5 },
    cwd: "/Users/test/project",
  };

  test("keeps ordinary sessions", () => {
    expect(filterBySessionShape(baseSession, baseOptions())).toBeNull();
  });

  test("skips sidechains when disabled", () => {
    expect(
      filterBySessionShape(
        { ...baseSession, isSidechain: true },
        baseOptions(),
      ),
    ).toBe("sidechain");
  });

  test("skips temp cwd when disabled", () => {
    expect(
      filterBySessionShape(
        { ...baseSession, cwd: "/tmp/session" },
        baseOptions(),
      ),
    ).toBe("temp_cwd");
  });

  test("skips sessions with zero user turns", () => {
    expect(
      filterBySessionShape(
        { ...baseSession, messageCounts: { user: 0, assistant: 3 } },
        baseOptions(),
      ),
    ).toBe("trivial");
  });

  test("skips one-shot sessions (1 user turn, regardless of assistant count)", () => {
    // Even a long assistant reply doesn't count — we require real
    // back-and-forth from the user side.
    expect(
      filterBySessionShape(
        { ...baseSession, messageCounts: { user: 1, assistant: 10 } },
        baseOptions(),
      ),
    ).toBe("trivial");
  });

  test("keeps sessions with 2+ user turns", () => {
    expect(
      filterBySessionShape(
        { ...baseSession, messageCounts: { user: 2, assistant: 1 } },
        baseOptions(),
      ),
    ).toBeNull();
  });
});
