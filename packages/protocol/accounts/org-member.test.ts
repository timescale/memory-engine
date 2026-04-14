/**
 * Tests for org-member protocol response schemas.
 *
 * Verifies the response schemas accept name and email fields.
 */
import { describe, expect, test } from "bun:test";
import { orgMemberResponse } from "./org-member.ts";

describe("orgMemberResponse", () => {
  test("accepts response with name and email", () => {
    const result = orgMemberResponse.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      role: "admin",
      name: "Alice Smith",
      email: "alice@example.com",
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects response missing name", () => {
    const result = orgMemberResponse.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      role: "member",
      email: "alice@example.com",
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  test("rejects response missing email", () => {
    const result = orgMemberResponse.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      role: "member",
      name: "Alice",
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
