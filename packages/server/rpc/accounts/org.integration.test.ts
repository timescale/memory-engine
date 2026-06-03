/**
 * Integration tests for org RPC handlers.
 *
 * Currently focused on org.update (rename). Other org methods are exercised
 * indirectly via engine.integration.test.ts and CLI smoke tests.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  type AccountsDB,
  createAccountsDB,
  type Identity,
} from "@memory.build/accounts";
import { TestDatabase as AccountsTestDatabase } from "@memory.build/accounts/migrate/test-utils";
import { SERVER_VERSION } from "../../../../version";
import type { HandlerContext } from "../types";
import { orgMethods } from "./org";
import type { AccountsRpcContext } from "./types";

let accountsTestDb: AccountsTestDatabase;
let accountsDb: AccountsDB;
let testIdentity: Identity;

beforeAll(async () => {
  accountsTestDb = await AccountsTestDatabase.create();
  accountsDb = createAccountsDB(accountsTestDb.sql, accountsTestDb.schema);

  testIdentity = await accountsDb.createIdentity({
    email: "org-rpc-test@example.com",
    name: "Org RPC Test User",
  });
});

afterAll(async () => {
  await accountsTestDb.dispose();
});

function createContext(identity: Identity): HandlerContext {
  return {
    request: new Request("http://localhost"),
    db: accountsDb,
    identity,
    // org.update never touches engineSql; a stub that satisfies the
    // assertAccountsRpcContext type guard (typeof === "function") is enough.
    engineSql: mock(() => {}) as unknown,
    serverVersion: SERVER_VERSION,
  } as unknown as AccountsRpcContext;
}

describe("org.update integration", () => {
  function getUpdateHandler() {
    const handler = orgMethods.get("org.update")?.handler;
    if (!handler) throw new Error("org.update handler not found");
    return handler;
  }

  test("owner can rename org; slug is unchanged", async () => {
    const update = getUpdateHandler();
    const org = await accountsDb.createOrg({ name: "Original Org Name" });
    await accountsDb.addMember(org.id, testIdentity.id, "owner");

    const result = (await update(
      { id: org.id, name: "Renamed Org" },
      createContext(testIdentity),
    )) as { id: string; name: string; slug: string; updatedAt: string | null };

    expect(result.id).toBe(org.id);
    expect(result.name).toBe("Renamed Org");
    expect(result.slug).toBe(org.slug);
    expect(result.updatedAt).not.toBeNull();
  });

  test("admin can rename org", async () => {
    const update = getUpdateHandler();
    const org = await accountsDb.createOrg({ name: "Admin Rename" });
    await accountsDb.addMember(org.id, testIdentity.id, "owner");

    const admin = await accountsDb.createIdentity({
      email: "org-admin@example.com",
      name: "Org Admin",
    });
    await accountsDb.addMember(org.id, admin.id, "admin");

    const result = (await update(
      { id: org.id, name: "Renamed By Admin" },
      createContext(admin),
    )) as { name: string };

    expect(result.name).toBe("Renamed By Admin");
  });

  test("member (non-admin) cannot rename org", async () => {
    const update = getUpdateHandler();
    const org = await accountsDb.createOrg({ name: "Member Rename" });
    await accountsDb.addMember(org.id, testIdentity.id, "owner");

    const member = await accountsDb.createIdentity({
      email: "org-member@example.com",
      name: "Org Member",
    });
    await accountsDb.addMember(org.id, member.id, "member");

    await expect(
      update({ id: org.id, name: "Forbidden" }, createContext(member)),
    ).rejects.toThrow("Only owners and admins can update the organization");
  });

  test("non-member cannot rename org", async () => {
    const update = getUpdateHandler();
    const org = await accountsDb.createOrg({ name: "Outsider Rename" });
    await accountsDb.addMember(org.id, testIdentity.id, "owner");

    const outsider = await accountsDb.createIdentity({
      email: "org-outsider@example.com",
      name: "Org Outsider",
    });

    await expect(
      update({ id: org.id, name: "Forbidden" }, createContext(outsider)),
    ).rejects.toThrow("Only owners and admins can update the organization");
  });

  test("two orgs can share the same name (no unique constraint)", async () => {
    const update = getUpdateHandler();

    const orgA = await accountsDb.createOrg({ name: "Shared Name Source" });
    await accountsDb.addMember(orgA.id, testIdentity.id, "owner");
    const orgB = await accountsDb.createOrg({ name: "Other Org" });
    await accountsDb.addMember(orgB.id, testIdentity.id, "owner");

    const result = (await update(
      { id: orgB.id, name: "Shared Name Source" },
      createContext(testIdentity),
    )) as { name: string };

    expect(result.name).toBe("Shared Name Source");
    const fetched = await accountsDb.getOrg(orgA.id);
    expect(fetched?.name).toBe("Shared Name Source");
  });

  test("renaming a non-existent org returns FORBIDDEN (no membership)", async () => {
    // Membership check runs before the org lookup, so a missing org id
    // surfaces as a FORBIDDEN rather than NOT_FOUND for callers who are
    // not members. This matches the rest of the codebase's defense-in-depth.
    const update = getUpdateHandler();
    await expect(
      update(
        { id: "019d694f-79f6-7595-8faf-b70b01c11f98", name: "Nope" },
        createContext(testIdentity),
      ),
    ).rejects.toThrow("Only owners and admins can update the organization");
  });
});
