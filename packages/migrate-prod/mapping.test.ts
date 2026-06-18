import { describe, expect, test } from "bun:test";
import { mapActionsToLevel, orgRoleIsAdmin } from "./mapping";

describe("mapActionsToLevel", () => {
  test("read-only → read (1)", () => {
    expect(mapActionsToLevel(["read"], false)).toBe(1);
  });

  test("any write action → write (2), additive over read", () => {
    expect(mapActionsToLevel(["create"], false)).toBe(2);
    expect(mapActionsToLevel(["update"], false)).toBe(2);
    expect(mapActionsToLevel(["delete"], false)).toBe(2);
    expect(mapActionsToLevel(["read", "create"], false)).toBe(2);
    expect(
      mapActionsToLevel(["read", "create", "update", "delete"], false),
    ).toBe(2);
  });

  test("with_grant_option (delegation) → owner (3), regardless of actions", () => {
    expect(mapActionsToLevel(["read"], true)).toBe(3);
    expect(mapActionsToLevel([], true)).toBe(3);
  });

  test("empty action set defaults to read (1)", () => {
    expect(mapActionsToLevel([], false)).toBe(1);
  });
});

describe("orgRoleIsAdmin", () => {
  test("owner and admin are admins; member is not", () => {
    expect(orgRoleIsAdmin("owner")).toBe(true);
    expect(orgRoleIsAdmin("admin")).toBe(true);
    expect(orgRoleIsAdmin("member")).toBe(false);
  });
});
