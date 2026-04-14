/**
 * Tests for owner protocol response schemas.
 *
 * Verifies the response schemas accept userName and createdByName.
 */
import { describe, expect, test } from "bun:test";
import { ownerResponse } from "./owner.ts";

describe("ownerResponse", () => {
  test("accepts response with userName and createdByName", () => {
    const result = ownerResponse.safeParse({
      treePath: "work.projects",
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      userName: "alice",
      createdBy: "019d694f-79f6-7595-8faf-b70b01c11f99",
      createdByName: "admin",
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("accepts null createdBy and createdByName", () => {
    const result = ownerResponse.safeParse({
      treePath: "work",
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      userName: "alice",
      createdBy: null,
      createdByName: null,
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects response missing userName", () => {
    const result = ownerResponse.safeParse({
      treePath: "work",
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      createdBy: null,
      createdByName: null,
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
