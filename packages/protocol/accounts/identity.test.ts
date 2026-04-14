/**
 * Tests for identity protocol schemas.
 */
import { describe, expect, test } from "bun:test";
import {
  identityGetByEmailParams,
  identityGetByEmailResult,
  identityResponse,
} from "./identity.ts";

describe("identityGetByEmailParams", () => {
  test("accepts valid email", () => {
    expect(
      identityGetByEmailParams.safeParse({ email: "a@b.com" }).success,
    ).toBe(true);
  });

  test("rejects invalid email", () => {
    expect(identityGetByEmailParams.safeParse({ email: "nope" }).success).toBe(
      false,
    );
  });

  test("rejects missing email", () => {
    expect(identityGetByEmailParams.safeParse({}).success).toBe(false);
  });
});

describe("identityGetByEmailResult", () => {
  test("accepts identity with all fields", () => {
    const result = identityGetByEmailResult.safeParse({
      identity: {
        id: "019d694f-79f6-7595-8faf-b70b01c11f98",
        email: "a@b.com",
        name: "Alice",
        createdAt: "2026-01-15T00:00:00.000Z",
        updatedAt: null,
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts null identity", () => {
    const result = identityGetByEmailResult.safeParse({ identity: null });
    expect(result.success).toBe(true);
  });
});

describe("identityResponse", () => {
  test("accepts valid identity", () => {
    const result = identityResponse.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "a@b.com",
      name: "Alice",
      createdAt: "2026-01-15T00:00:00.000Z",
      updatedAt: null,
    });
    expect(result.success).toBe(true);
  });
});
