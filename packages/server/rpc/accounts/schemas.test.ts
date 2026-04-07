/**
 * Tests for Accounts RPC schemas.
 */
import { describe, expect, test } from "bun:test";
import {
  emailSchema,
  engineCreateSchema,
  engineGetSchema,
  engineListSchema,
  engineStatusSchema,
  engineUpdateSchema,
  invitationAcceptSchema,
  invitationCreateSchema,
  invitationListSchema,
  invitationRevokeSchema,
  meGetSchema,
  nameSchema,
  orgCreateSchema,
  orgDeleteSchema,
  orgGetSchema,
  orgListSchema,
  orgMemberAddSchema,
  orgMemberListSchema,
  orgMemberRemoveSchema,
  orgMemberUpdateRoleSchema,
  orgRoleSchema,
  orgUpdateSchema,
  slugSchema,
  uuidv7Schema,
} from "./schemas";

// =============================================================================
// Common Schema Tests
// =============================================================================

describe("uuidv7Schema", () => {
  test("accepts valid UUIDv7", () => {
    const validUuids = [
      "019d694f-79f6-7595-8faf-b70b01c11f98",
      "019d694f-79f6-7595-9faf-b70b01c11f98",
      "019d694f-79f6-7595-afaf-b70b01c11f98",
      "019d694f-79f6-7595-bfaf-b70b01c11f98",
    ];
    for (const uuid of validUuids) {
      expect(uuidv7Schema.safeParse(uuid).success).toBe(true);
    }
  });

  test("rejects invalid UUIDs", () => {
    const invalidUuids = [
      "not-a-uuid",
      "019d694f-79f6-4595-8faf-b70b01c11f98", // v4 not v7
      "019d694f-79f6-7595-0faf-b70b01c11f98", // invalid variant
      "019d694f79f675958fafb70b01c11f98", // no dashes
      "",
    ];
    for (const uuid of invalidUuids) {
      expect(uuidv7Schema.safeParse(uuid).success).toBe(false);
    }
  });
});

describe("slugSchema", () => {
  test("accepts valid slugs", () => {
    const validSlugs = [
      "abc",
      "my-org",
      "acme-corp",
      "test123",
      "my-cool-org-name",
    ];
    for (const slug of validSlugs) {
      expect(slugSchema.safeParse(slug).success).toBe(true);
    }
  });

  test("rejects invalid slugs", () => {
    const invalidSlugs = [
      "ab", // too short
      "My-Org", // uppercase
      "my_org", // underscore
      "-my-org", // leading hyphen
      "my-org-", // trailing hyphen
      "my--org", // double hyphen
      "my org", // space
      "a".repeat(51), // too long
    ];
    for (const slug of invalidSlugs) {
      expect(slugSchema.safeParse(slug).success).toBe(false);
    }
  });
});

describe("emailSchema", () => {
  test("accepts valid emails", () => {
    const validEmails = [
      "user@example.com",
      "user.name@example.com",
      "user+tag@example.com",
      "user@subdomain.example.com",
    ];
    for (const email of validEmails) {
      expect(emailSchema.safeParse(email).success).toBe(true);
    }
  });

  test("rejects invalid emails", () => {
    const invalidEmails = ["not-an-email", "user@", "@example.com", ""];
    for (const email of invalidEmails) {
      expect(emailSchema.safeParse(email).success).toBe(false);
    }
  });
});

describe("nameSchema", () => {
  test("accepts valid names", () => {
    const validNames = ["a", "John Doe", "My Organization", "a".repeat(100)];
    for (const name of validNames) {
      expect(nameSchema.safeParse(name).success).toBe(true);
    }
  });

  test("rejects invalid names", () => {
    const invalidNames = ["", "a".repeat(101)];
    for (const name of invalidNames) {
      expect(nameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("orgRoleSchema", () => {
  test("accepts valid roles", () => {
    const validRoles = ["owner", "admin", "member"];
    for (const role of validRoles) {
      expect(orgRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  test("rejects invalid roles", () => {
    const invalidRoles = ["superuser", "guest", "", "OWNER"];
    for (const role of invalidRoles) {
      expect(orgRoleSchema.safeParse(role).success).toBe(false);
    }
  });
});

describe("engineStatusSchema", () => {
  test("accepts valid statuses", () => {
    const validStatuses = ["active", "suspended", "deleted"];
    for (const status of validStatuses) {
      expect(engineStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  test("rejects invalid statuses", () => {
    const invalidStatuses = ["pending", "inactive", "", "ACTIVE"];
    for (const status of invalidStatuses) {
      expect(engineStatusSchema.safeParse(status).success).toBe(false);
    }
  });
});

// =============================================================================
// Me Schema Tests
// =============================================================================

describe("meGetSchema", () => {
  test("accepts empty params", () => {
    const result = meGetSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("ignores extra params", () => {
    const result = meGetSchema.safeParse({ extra: "ignored" });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Org Schema Tests
// =============================================================================

describe("orgCreateSchema", () => {
  test("accepts valid params", () => {
    const result = orgCreateSchema.safeParse({
      slug: "my-org",
      name: "My Organization",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid slug", () => {
    const result = orgCreateSchema.safeParse({
      slug: "My Org", // invalid - uppercase and space
      name: "My Organization",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty name", () => {
    const result = orgCreateSchema.safeParse({
      slug: "my-org",
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("orgListSchema", () => {
  test("accepts empty params", () => {
    const result = orgListSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("orgGetSchema", () => {
  test("accepts valid UUID", () => {
    const result = orgGetSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid UUID", () => {
    const result = orgGetSchema.safeParse({
      id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("orgUpdateSchema", () => {
  test("accepts id with name update", () => {
    const result = orgUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "New Name",
    });
    expect(result.success).toBe(true);
  });

  test("accepts id with slug update", () => {
    const result = orgUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      slug: "new-slug",
    });
    expect(result.success).toBe(true);
  });

  test("accepts id only (no-op)", () => {
    const result = orgUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid slug", () => {
    const result = orgUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      slug: "Invalid Slug",
    });
    expect(result.success).toBe(false);
  });
});

describe("orgDeleteSchema", () => {
  test("accepts valid UUID", () => {
    const result = orgDeleteSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Org Member Schema Tests
// =============================================================================

describe("orgMemberListSchema", () => {
  test("accepts valid orgId", () => {
    const result = orgMemberListSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("orgMemberAddSchema", () => {
  test("accepts valid params", () => {
    const result = orgMemberAddSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      role: "member",
    });
    expect(result.success).toBe(true);
  });

  test("accepts all roles", () => {
    for (const role of ["owner", "admin", "member"]) {
      const result = orgMemberAddSchema.safeParse({
        orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
        identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
        role,
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid role", () => {
    const result = orgMemberAddSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      role: "superuser",
    });
    expect(result.success).toBe(false);
  });
});

describe("orgMemberRemoveSchema", () => {
  test("accepts valid params", () => {
    const result = orgMemberRemoveSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
    });
    expect(result.success).toBe(true);
  });
});

describe("orgMemberUpdateRoleSchema", () => {
  test("accepts valid params", () => {
    const result = orgMemberUpdateRoleSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      role: "admin",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Engine Schema Tests
// =============================================================================

describe("engineCreateSchema", () => {
  test("accepts valid params", () => {
    const result = engineCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "My Engine",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = engineCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("engineListSchema", () => {
  test("accepts valid orgId", () => {
    const result = engineListSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("engineGetSchema", () => {
  test("accepts valid UUID", () => {
    const result = engineGetSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("engineUpdateSchema", () => {
  test("accepts name update", () => {
    const result = engineUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "New Engine Name",
    });
    expect(result.success).toBe(true);
  });

  test("accepts status update", () => {
    const result = engineUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      status: "suspended",
    });
    expect(result.success).toBe(true);
  });

  test("accepts id only (no-op)", () => {
    const result = engineUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = engineUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      status: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Invitation Schema Tests
// =============================================================================

describe("invitationCreateSchema", () => {
  test("accepts minimal params", () => {
    const result = invitationCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "user@example.com",
      role: "member",
    });
    expect(result.success).toBe(true);
  });

  test("accepts with expiresInDays", () => {
    const result = invitationCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "user@example.com",
      role: "admin",
      expiresInDays: 14,
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid email", () => {
    const result = invitationCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "not-an-email",
      role: "member",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid role", () => {
    const result = invitationCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "user@example.com",
      role: "superuser",
    });
    expect(result.success).toBe(false);
  });

  test("rejects expiresInDays < 1", () => {
    const result = invitationCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "user@example.com",
      role: "member",
      expiresInDays: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects expiresInDays > 30", () => {
    const result = invitationCreateSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "user@example.com",
      role: "member",
      expiresInDays: 31,
    });
    expect(result.success).toBe(false);
  });
});

describe("invitationListSchema", () => {
  test("accepts valid orgId", () => {
    const result = invitationListSchema.safeParse({
      orgId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("invitationRevokeSchema", () => {
  test("accepts valid UUID", () => {
    const result = invitationRevokeSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("invitationAcceptSchema", () => {
  test("accepts valid token", () => {
    const result = invitationAcceptSchema.safeParse({
      token: "some-invitation-token-here",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty token", () => {
    const result = invitationAcceptSchema.safeParse({
      token: "",
    });
    expect(result.success).toBe(false);
  });
});
