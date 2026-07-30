/**
 * Unit tests for `agent-install.ts` helpers.
 *
 * `runAgentMcpInstall` itself shells out to external binaries (`claude mcp
 * add`, etc.) and calls `process.exit`, so we test the decisions it makes
 * through the pure `multiSpaceWarning` helper it delegates to. Both the
 * session and the api-key branch consult the same helper — the wire-level
 * runtime behavior is identical (the MCP server starts multi-space unless
 * `--space` was baked in), and the warning tracks that.
 */

import { describe, expect, test } from "bun:test";
import { multiSpaceWarning } from "./agent-install.ts";

describe("multiSpaceWarning", () => {
  test("returns a warn message when no space is baked in", () => {
    const warn = multiSpaceWarning(undefined);
    expect(warn).toBeString();
    // Guide the operator to the discovery flow.
    expect(warn).toContain("multi-space");
    expect(warn).toContain("me_space_list");
    expect(warn).toContain("--space");
  });

  test("stays quiet when a space is baked in (locked at runtime)", () => {
    expect(multiSpaceWarning("abc123def456")).toBeUndefined();
  });

  test("warns when a whitespace-only flag becomes multi-space at runtime", () => {
    expect(multiSpaceWarning("  ")).toBeString();
  });

  test("fires on the api-key path too — the warning is credential-agnostic", () => {
    // The install code emits this after picking meCmd for either the session
    // OR the api-key path, so a headless install without --space is now
    // warned the same way as a session install without --space.
    expect(multiSpaceWarning(undefined)).toBeString();
  });
});
