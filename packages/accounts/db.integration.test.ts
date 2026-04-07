import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AccountsDB, createAccountsDB } from "./db";
import { TestDatabase } from "./migrate/test-utils";
import { AccountsError } from "./types";

// Test master key (32 bytes for AES-256)
const TEST_MASTER_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf-8",
);

let testDb: TestDatabase;
let db: AccountsDB;

beforeAll(async () => {
  testDb = await TestDatabase.create();

  db = createAccountsDB(testDb.sql, testDb.schema, {
    masterKey: TEST_MASTER_KEY,
  });

  // Create and activate an encryption key for tests
  const keyId = await db.createDataKey();
  await db.activateDataKey(keyId);
});

afterAll(async () => {
  await testDb.dispose();
});

// ---------------------------------------------------------------------------
// Identity tests
// ---------------------------------------------------------------------------

describe("identity", () => {
  test("create and get identity", async () => {
    const identity = await db.createIdentity({
      email: "test@example.com",
      name: "Test User",
    });

    expect(identity.id).toBeDefined();
    expect(identity.email).toBe("test@example.com");
    expect(identity.name).toBe("Test User");

    const fetched = await db.getIdentity(identity.id);
    expect(fetched).toEqual(identity);
  });

  test("get identity by email", async () => {
    const identity = await db.createIdentity({
      email: "byemail@example.com",
      name: "By Email",
    });

    const fetched = await db.getIdentityByEmail("byemail@example.com");
    expect(fetched?.id).toBe(identity.id);
  });

  test("update identity", async () => {
    const identity = await db.createIdentity({
      email: "update@example.com",
      name: "Original Name",
    });

    const updated = await db.updateIdentity(identity.id, { name: "New Name" });
    expect(updated).toBe(true);

    const fetched = await db.getIdentity(identity.id);
    expect(fetched?.name).toBe("New Name");
  });

  test("delete identity", async () => {
    const identity = await db.createIdentity({
      email: "delete@example.com",
      name: "To Delete",
    });

    const deleted = await db.deleteIdentity(identity.id);
    expect(deleted).toBe(true);

    const fetched = await db.getIdentity(identity.id);
    expect(fetched).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Org tests
// ---------------------------------------------------------------------------

describe("org", () => {
  test("create and get org", async () => {
    const org = await db.createOrg({
      slug: "test-org",
      name: "Test Organization",
    });

    expect(org.id).toBeDefined();
    expect(org.slug).toBe("test-org");
    expect(org.name).toBe("Test Organization");

    const fetched = await db.getOrg(org.id);
    expect(fetched).toEqual(org);
  });

  test("get org by slug", async () => {
    const org = await db.createOrg({
      slug: "by-slug-org",
      name: "By Slug",
    });

    const fetched = await db.getOrgBySlug("by-slug-org");
    expect(fetched?.id).toBe(org.id);
  });

  test("list orgs by identity", async () => {
    const identity = await db.createIdentity({
      email: "orglist@example.com",
      name: "Org List User",
    });

    const org1 = await db.createOrg({ slug: "list-org-1", name: "Org 1" });
    const org2 = await db.createOrg({ slug: "list-org-2", name: "Org 2" });

    await db.addMember(org1.id, identity.id, "owner");
    await db.addMember(org2.id, identity.id, "member");

    const orgs = await db.listOrgsByIdentity(identity.id);
    expect(orgs.length).toBe(2);
    expect(orgs.map((o) => o.id).sort()).toEqual([org1.id, org2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// OrgMember tests
// ---------------------------------------------------------------------------

describe("org-member", () => {
  test("add and list members", async () => {
    const org = await db.createOrg({
      slug: "member-test",
      name: "Member Test",
    });
    const identity = await db.createIdentity({
      email: "member@example.com",
      name: "Member",
    });

    const member = await db.addMember(org.id, identity.id, "admin");
    expect(member.orgId).toBe(org.id);
    expect(member.identityId).toBe(identity.id);
    expect(member.role).toBe("admin");

    const members = await db.listMembers(org.id);
    expect(members.length).toBe(1);
  });

  test("update role", async () => {
    const org = await db.createOrg({
      slug: "role-update",
      name: "Role Update",
    });
    const identity = await db.createIdentity({
      email: "roleupdate@example.com",
      name: "Role Update",
    });

    await db.addMember(org.id, identity.id, "member");
    await db.updateRole(org.id, identity.id, "admin");

    const member = await db.getMember(org.id, identity.id);
    expect(member?.role).toBe("admin");
  });

  test("cannot remove last owner", async () => {
    const org = await db.createOrg({ slug: "last-owner", name: "Last Owner" });
    const identity = await db.createIdentity({
      email: "lastowner@example.com",
      name: "Last Owner",
    });

    await db.addMember(org.id, identity.id, "owner");

    await expect(db.removeMember(org.id, identity.id)).rejects.toThrow(
      AccountsError,
    );
  });

  test("cannot demote last owner", async () => {
    const org = await db.createOrg({
      slug: "demote-owner",
      name: "Demote Owner",
    });
    const identity = await db.createIdentity({
      email: "demoteowner@example.com",
      name: "Demote Owner",
    });

    await db.addMember(org.id, identity.id, "owner");

    await expect(db.updateRole(org.id, identity.id, "admin")).rejects.toThrow(
      AccountsError,
    );
  });

  test("can remove owner if another owner exists", async () => {
    const org = await db.createOrg({
      slug: "multi-owner",
      name: "Multi Owner",
    });
    const owner1 = await db.createIdentity({
      email: "owner1@example.com",
      name: "Owner 1",
    });
    const owner2 = await db.createIdentity({
      email: "owner2@example.com",
      name: "Owner 2",
    });

    await db.addMember(org.id, owner1.id, "owner");
    await db.addMember(org.id, owner2.id, "owner");

    const removed = await db.removeMember(org.id, owner1.id);
    expect(removed).toBe(true);

    const owners = await db.listOwners(org.id);
    expect(owners.length).toBe(1);
    expect(owners[0]?.identityId).toBe(owner2.id);
  });
});

// ---------------------------------------------------------------------------
// Engine tests
// ---------------------------------------------------------------------------

describe("engine", () => {
  test("create engine with generated slug", async () => {
    const org = await db.createOrg({ slug: "engine-org", name: "Engine Org" });

    const engine = await db.createEngine({
      orgId: org.id,
      name: "My Engine",
    });

    expect(engine.id).toBeDefined();
    expect(engine.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(engine.name).toBe("My Engine");
    expect(engine.status).toBe("active");
    expect(engine.shardId).toBe(1);
  });

  test("get engine by slug", async () => {
    const org = await db.createOrg({
      slug: "engine-slug",
      name: "Engine Slug",
    });
    const engine = await db.createEngine({
      orgId: org.id,
      name: "Slug Engine",
    });

    const fetched = await db.getEngineBySlug(engine.slug);
    expect(fetched?.id).toBe(engine.id);
  });

  test("update engine status", async () => {
    const org = await db.createOrg({ slug: "engine-status", name: "Status" });
    const engine = await db.createEngine({
      orgId: org.id,
      name: "Status Engine",
    });

    await db.updateEngine(engine.id, { status: "suspended" });

    const fetched = await db.getEngine(engine.id);
    expect(fetched?.status).toBe("suspended");
  });

  test("list engines by org", async () => {
    const org = await db.createOrg({
      slug: "list-engines",
      name: "List Engines",
    });
    await db.createEngine({ orgId: org.id, name: "Engine A" });
    await db.createEngine({ orgId: org.id, name: "Engine B" });

    const engines = await db.listEnginesByOrg(org.id);
    expect(engines.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Session tests
// ---------------------------------------------------------------------------

describe("session", () => {
  test("create and validate session", async () => {
    const identity = await db.createIdentity({
      email: "session@example.com",
      name: "Session User",
    });

    const { session, rawToken } = await db.createSession({
      identityId: identity.id,
    });

    expect(session.identityId).toBe(identity.id);
    expect(rawToken).toBeDefined();

    const result = await db.validateSession(rawToken);
    expect(result?.session.id).toBe(session.id);
    expect(result?.identity.id).toBe(identity.id);
  });

  test("invalid token returns null", async () => {
    const result = await db.validateSession("invalid-token");
    expect(result).toBeNull();
  });

  test("delete session", async () => {
    const identity = await db.createIdentity({
      email: "deletesession@example.com",
      name: "Delete Session",
    });

    const { session, rawToken } = await db.createSession({
      identityId: identity.id,
    });

    await db.deleteSession(session.id);

    const result = await db.validateSession(rawToken);
    expect(result).toBeNull();
  });

  test("delete all sessions for identity", async () => {
    const identity = await db.createIdentity({
      email: "allsessions@example.com",
      name: "All Sessions",
    });

    await db.createSession({ identityId: identity.id });
    await db.createSession({ identityId: identity.id });

    const count = await db.deleteSessionsByIdentity(identity.id);
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Invitation tests
// ---------------------------------------------------------------------------

describe("invitation", () => {
  test("create and find invitation by token", async () => {
    const org = await db.createOrg({ slug: "invite-org", name: "Invite Org" });
    const inviter = await db.createIdentity({
      email: "inviter@example.com",
      name: "Inviter",
    });

    const { invitation, rawToken } = await db.createInvitation({
      orgId: org.id,
      email: "invitee@example.com",
      role: "member",
      invitedBy: inviter.id,
    });

    expect(invitation.orgId).toBe(org.id);
    expect(invitation.email).toBe("invitee@example.com");
    expect(rawToken).toBeDefined();

    const found = await db.getInvitationByToken(rawToken);
    expect(found?.id).toBe(invitation.id);
  });

  test("accept invitation", async () => {
    const org = await db.createOrg({ slug: "accept-org", name: "Accept Org" });
    const inviter = await db.createIdentity({
      email: "acceptinviter@example.com",
      name: "Inviter",
    });

    const { invitation } = await db.createInvitation({
      orgId: org.id,
      email: "acceptee@example.com",
      role: "admin",
      invitedBy: inviter.id,
    });

    const accepted = await db.acceptInvitation(invitation.id);
    expect(accepted?.acceptedAt).toBeDefined();
  });

  test("list pending invitations", async () => {
    const org = await db.createOrg({
      slug: "pending-org",
      name: "Pending Org",
    });
    const inviter = await db.createIdentity({
      email: "pendinginviter@example.com",
      name: "Inviter",
    });

    await db.createInvitation({
      orgId: org.id,
      email: "pending1@example.com",
      role: "member",
      invitedBy: inviter.id,
    });
    await db.createInvitation({
      orgId: org.id,
      email: "pending2@example.com",
      role: "member",
      invitedBy: inviter.id,
    });

    const pending = await db.listPendingInvitations(org.id);
    expect(pending.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// OAuth tests
// ---------------------------------------------------------------------------

describe("oauth", () => {
  test("link and get oauth account", async () => {
    const identity = await db.createIdentity({
      email: "oauth@example.com",
      name: "OAuth User",
    });

    const oauth = await db.linkOAuthAccount({
      identityId: identity.id,
      provider: "github",
      providerAccountId: "gh-123",
      email: "oauth@example.com",
      accessToken: "access-token-123",
      refreshToken: "refresh-token-456",
    });

    expect(oauth.provider).toBe("github");
    expect(oauth.providerAccountId).toBe("gh-123");

    const fetched = await db.getOAuthAccount("github", "gh-123");
    expect(fetched?.id).toBe(oauth.id);
  });

  test("get decrypted tokens", async () => {
    const identity = await db.createIdentity({
      email: "oauthtokens@example.com",
      name: "OAuth Tokens",
    });

    const oauth = await db.linkOAuthAccount({
      identityId: identity.id,
      provider: "google",
      providerAccountId: "google-abc",
      accessToken: "my-access-token",
      refreshToken: "my-refresh-token",
    });

    const tokens = await db.getOAuthTokens(oauth.id);
    expect(tokens?.accessToken).toBe("my-access-token");
    expect(tokens?.refreshToken).toBe("my-refresh-token");
  });

  test("refresh oauth tokens", async () => {
    const identity = await db.createIdentity({
      email: "refreshtokens@example.com",
      name: "Refresh Tokens",
    });

    const oauth = await db.linkOAuthAccount({
      identityId: identity.id,
      provider: "github",
      providerAccountId: "gh-refresh",
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    await db.refreshOAuthTokens(oauth.id, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });

    const tokens = await db.getOAuthTokens(oauth.id);
    expect(tokens?.accessToken).toBe("new-access");
    expect(tokens?.refreshToken).toBe("new-refresh");
  });

  test("list oauth accounts by identity", async () => {
    const identity = await db.createIdentity({
      email: "multioauth@example.com",
      name: "Multi OAuth",
    });

    await db.linkOAuthAccount({
      identityId: identity.id,
      provider: "github",
      providerAccountId: "gh-multi",
      accessToken: "token1",
    });
    await db.linkOAuthAccount({
      identityId: identity.id,
      provider: "google",
      providerAccountId: "google-multi",
      accessToken: "token2",
    });

    const accounts = await db.getOAuthAccountsByIdentity(identity.id);
    expect(accounts.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Encryption key rotation test
// ---------------------------------------------------------------------------

describe("encryption key rotation", () => {
  test("can rotate encryption keys", async () => {
    const identity = await db.createIdentity({
      email: "rotation@example.com",
      name: "Rotation Test",
    });

    // Link with current key
    const oauth = await db.linkOAuthAccount({
      identityId: identity.id,
      provider: "github",
      providerAccountId: "gh-rotation",
      accessToken: "original-token",
    });

    // Create and activate new key
    const newKeyId = await db.createDataKey();
    await db.activateDataKey(newKeyId);

    // Old tokens should still decrypt (using old key stored with them)
    const tokens = await db.getOAuthTokens(oauth.id);
    expect(tokens?.accessToken).toBe("original-token");

    // New tokens will use the new key
    await db.refreshOAuthTokens(oauth.id, { accessToken: "rotated-token" });

    const newTokens = await db.getOAuthTokens(oauth.id);
    expect(newTokens?.accessToken).toBe("rotated-token");
  });
});

// ---------------------------------------------------------------------------
// Transaction test
// ---------------------------------------------------------------------------

describe("transactions", () => {
  test("withTransaction commits on success", async () => {
    const result = await db.withTransaction(async (txDb) => {
      const identity = await txDb.createIdentity({
        email: "txsuccess@example.com",
        name: "TX Success",
      });
      return identity;
    });

    const fetched = await db.getIdentity(result.id);
    expect(fetched).toBeDefined();
  });

  test("withTransaction rolls back on error", async () => {
    const email = "txrollback@example.com";

    try {
      await db.withTransaction(async (txDb) => {
        await txDb.createIdentity({ email, name: "TX Rollback" });
        throw new Error("Intentional error");
      });
    } catch {
      // Expected
    }

    const fetched = await db.getIdentityByEmail(email);
    expect(fetched).toBeNull();
  });
});
