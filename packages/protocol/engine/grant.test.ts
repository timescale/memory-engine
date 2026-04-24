/**
 * Tests for grant protocol response schemas.
 *
 * Verifies the response schemas accept the userName field added via JOINs.
 */
import { describe, expect, test } from "bun:test";
import { grantResponse } from "./grant.ts";

describe("grantResponse", () => {
  test("accepts response with userName", () => {
    const result = grantResponse.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      userId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      userName: "alice",
      treePath: "work.projects",
      actions: ["read", "create"],
      grantedBy: null,
      withGrantOption: false,
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects response missing userName", () => {
    const result = grantResponse.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      userId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      treePath: "work.projects",
      actions: ["read"],
      grantedBy: null,
      withGrantOption: false,
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
