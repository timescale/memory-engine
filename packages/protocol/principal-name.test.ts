import { describe, expect, test } from "bun:test";
import { principalHandleNameSchema } from "./fields.ts";
import { groupCreateParams, groupRenameParams } from "./space/group.ts";
import { principalKindSchema } from "./space/principal.ts";
import {
  serviceAccountCreateParams,
  serviceAccountRenameParams,
} from "./user/service-account.ts";

const uuidv7 = "01900000-0000-7000-8000-000000000000";

describe("principalHandleNameSchema", () => {
  test("accepts group/service-account handle names", () => {
    for (const ok of ["backend", "backend-team", "ci_agent", "bot.v2", "a"]) {
      expect(principalHandleNameSchema.safeParse(ok).success).toBe(true);
    }
  });

  test("rejects email-like names, slashes, spaces, leading punctuation, and > 100 chars", () => {
    for (const bad of [
      "",
      "alice@example.com",
      "john+bot",
      "team/backend",
      "team admin",
      "-prod",
      ".group",
      "a".repeat(101),
    ]) {
      expect(principalHandleNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("principalKindSchema", () => {
  test("accepts user, group, and service account kinds", () => {
    for (const kind of ["u", "g", "s"]) {
      expect(principalKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(principalKindSchema.safeParse("x").success).toBe(false);
  });
});

describe("group/service-account params", () => {
  test("group create/rename validate handle names", () => {
    expect(groupCreateParams.safeParse({ name: "backend-team" }).success).toBe(
      true,
    );
    expect(
      groupRenameParams.safeParse({ id: uuidv7, name: "ops.v2" }).success,
    ).toBe(true);
    expect(groupCreateParams.safeParse({ name: "team admin" }).success).toBe(
      false,
    );
    expect(
      groupRenameParams.safeParse({ id: uuidv7, name: "john+team" }).success,
    ).toBe(false);
  });

  test("service account create/rename validate handle names", () => {
    expect(
      serviceAccountCreateParams.safeParse({
        spaceId: uuidv7,
        name: "docs-importer",
      }).success,
    ).toBe(true);
    expect(
      serviceAccountCreateParams.safeParse({
        spaceId: uuidv7,
        name: "eon",
        adminMembers: [{ memberId: uuidv7, admin: true }],
      }).success,
    ).toBe(true);
    expect(
      serviceAccountRenameParams.safeParse({ id: uuidv7, name: "ci_bot" })
        .success,
    ).toBe(true);
    expect(
      serviceAccountCreateParams.safeParse({
        spaceId: uuidv7,
        name: "svc@example.com",
      }).success,
    ).toBe(false);
    expect(
      serviceAccountRenameParams.safeParse({ id: uuidv7, name: "bad/name" })
        .success,
    ).toBe(false);
  });
});
