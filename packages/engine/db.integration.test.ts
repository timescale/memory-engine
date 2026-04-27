import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createEngineDB } from "./db";
import { bootstrap } from "./migrate/bootstrap";
import { provisionEngine } from "./migrate/provision";
import { TestDatabase } from "./migrate/test-utils";

const testDb = new TestDatabase();
let connectionString: string;
let sql: SQL;
const schema = "me_testengine01";

beforeAll(async () => {
  connectionString = await testDb.create();
  sql = new SQL(connectionString);
  await bootstrap(sql);
  await provisionEngine(sql, "testengine01", undefined, "0.1.0");
});

afterAll(async () => {
  await sql.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Principal Tests
// ---------------------------------------------------------------------------
describe("user ops", () => {
  test("createUser creates a principal", async () => {
    const db = createEngineDB(sql, schema);
    const user = await db.createUser({
      name: "test-user",
    });

    expect(user.name).toBe("test-user");
    expect(user.superuser).toBe(false);
    expect(user.id).toBeDefined();
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  test("createUser with custom id", async () => {
    const db = createEngineDB(sql, schema);
    // Generate a UUIDv7 for testing
    const customId = crypto.randomUUID();
    // Replace version nibble with 7 to make it UUIDv7 compatible
    const uuidv7Id = customId.replace(
      /^(.{8}-.{4}-)(.)/,
      (_, prefix) => `${prefix}7`,
    );

    const user = await db.createUser({
      id: uuidv7Id,
      name: "test-user-with-id",
    });

    expect(user.id).toBe(uuidv7Id);
    expect(user.name).toBe("test-user-with-id");
  });

  test("createSuperuser creates a superuser principal", async () => {
    const db = createEngineDB(sql, schema);
    const superuser = await db.createSuperuser("admin");

    expect(superuser.name).toBe("admin");
    expect(superuser.superuser).toBe(true);
  });

  test("createSuperuser with custom id", async () => {
    const db = createEngineDB(sql, schema);
    const customId = crypto
      .randomUUID()
      .replace(/^(.{8}-.{4}-)(.)/, (_, prefix) => `${prefix}7`);
    const superuser = await db.createSuperuser("admin-with-id", customId);

    expect(superuser.id).toBe(customId);
    expect(superuser.name).toBe("admin-with-id");
    expect(superuser.superuser).toBe(true);
  });

  test("createUser with identityId and canLogin", async () => {
    const db = createEngineDB(sql, schema);
    const identityId = crypto
      .randomUUID()
      .replace(/^(.{8}-.{4}-)(.)/, (_, prefix) => `${prefix}7`);

    const user = await db.createUser({
      name: "owned-user",
      identityId: identityId,
      canLogin: true,
    });

    expect(user.name).toBe("owned-user");
    expect(user.identityId).toBe(identityId);
    expect(user.canLogin).toBe(true);
  });

  test("createRole creates a user with canLogin=false", async () => {
    const db = createEngineDB(sql, schema);
    const role = await db.createRole("test-role");

    expect(role.name).toBe("test-role");
    expect(role.canLogin).toBe(false);
    expect(role.superuser).toBe(false);
  });

  test("getUser returns user by ID", async () => {
    const db = createEngineDB(sql, schema);
    const created = await db.createUser({ name: "get-by-id-test" });
    const fetched = await db.getUser(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("get-by-id-test");
  });

  test("getUser returns null for non-existent ID", async () => {
    const db = createEngineDB(sql, schema);
    const fetched = await db.getUser("00000000-0000-0000-0000-000000000000");

    expect(fetched).toBeNull();
  });

  test("getUserByName returns principal by name", async () => {
    const db = createEngineDB(sql, schema);
    await db.createUser({ name: "get-by-name-test" });
    const fetched = await db.getUserByName("get-by-name-test");

    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("get-by-name-test");
  });

  test("getUserByName matches case-insensitively (citext)", async () => {
    const db = createEngineDB(sql, schema);
    const uniqueName = `ExactMatch_${Date.now()}`;
    await db.createUser({ name: uniqueName });
    const fetched = await db.getUserByName(uniqueName);

    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe(uniqueName);

    // citext: different case should still match
    const alsoFound = await db.getUserByName(uniqueName.toLowerCase());
    expect(alsoFound).not.toBeNull();
    expect(alsoFound!.id).toBe(fetched!.id);
  });

  test("listUsers returns all principals", async () => {
    const db = createEngineDB(sql, schema);
    const principals = await db.listUsers();

    expect(principals.length).toBeGreaterThan(0);
    expect(principals[0]!.id).toBeDefined();
  });

  test("renameUser updates name", async () => {
    const db = createEngineDB(sql, schema);
    const created = await db.createUser({ name: "rename-test" });
    const result = await db.renameUser(created.id, "renamed-test");

    expect(result).toBe(true);

    const fetched = await db.getUser(created.id);
    expect(fetched!.name).toBe("renamed-test");
  });

  test("deleteUser removes principal", async () => {
    const db = createEngineDB(sql, schema);
    const created = await db.createUser({ name: "delete-test" });
    const result = await db.deleteUser(created.id);

    expect(result).toBe(true);

    const fetched = await db.getUser(created.id);
    expect(fetched).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Grant Tests
// ---------------------------------------------------------------------------
describe("grant ops", () => {
  let testPrincipalId: string;

  beforeAll(async () => {
    const db = createEngineDB(sql, schema);
    const user = await db.createUser({ name: "grant-test-user" });
    testPrincipalId = user.id;
  });

  test("grantTreeAccess creates a grant", async () => {
    const db = createEngineDB(sql, schema);
    await db.grantTreeAccess({
      userId: testPrincipalId,
      treePath: "test.path",
      actions: ["read", "create"],
    });

    const grant = await db.getTreeGrant(testPrincipalId, "test.path");
    expect(grant).not.toBeNull();
    expect(grant!.userId).toBe(testPrincipalId);
    expect(grant!.treePath).toBe("test.path");
    expect(grant!.actions).toContain("read");
    expect(grant!.actions).toContain("create");
  });

  test("grantTreeAccess upserts on conflict", async () => {
    const db = createEngineDB(sql, schema);
    await db.grantTreeAccess({
      userId: testPrincipalId,
      treePath: "upsert.path",
      actions: ["read"],
    });

    await db.grantTreeAccess({
      userId: testPrincipalId,
      treePath: "upsert.path",
      actions: ["read", "create", "update"],
    });

    const grant = await db.getTreeGrant(testPrincipalId, "upsert.path");
    expect(grant!.actions).toHaveLength(3);
  });

  test("revokeTreeAccess removes grant", async () => {
    const db = createEngineDB(sql, schema);
    await db.grantTreeAccess({
      userId: testPrincipalId,
      treePath: "revoke.path",
      actions: ["read"],
    });

    const result = await db.revokeTreeAccess(testPrincipalId, "revoke.path");
    expect(result).toBe(true);

    const grant = await db.getTreeGrant(testPrincipalId, "revoke.path");
    expect(grant).toBeNull();
  });

  test("listTreeGrants returns grants for principal", async () => {
    const db = createEngineDB(sql, schema);
    await db.grantTreeAccess({
      userId: testPrincipalId,
      treePath: "list.path",
      actions: ["read"],
    });

    const grants = await db.listTreeGrants(testPrincipalId);
    expect(grants.length).toBeGreaterThan(0);
  });

  test("checkTreeAccess uses has_tree_access function", async () => {
    const db = createEngineDB(sql, schema);
    const superuser = await db.createSuperuser("access-check-admin");

    // Superuser should have access to everything
    const hasAccess = await db.checkTreeAccess(
      superuser.id,
      "any.path",
      "read",
    );
    expect(hasAccess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Owner Tests
// ---------------------------------------------------------------------------
describe("owner ops", () => {
  let testPrincipalId: string;

  beforeAll(async () => {
    const db = createEngineDB(sql, schema);
    const user = await db.createUser({ name: "owner-test-user" });
    testPrincipalId = user.id;
  });

  test("setTreeOwner creates ownership", async () => {
    const db = createEngineDB(sql, schema);
    await db.setTreeOwner(testPrincipalId, "owned.path");

    const owner = await db.getTreeOwner("owned.path");
    expect(owner).not.toBeNull();
    expect(owner!.userId).toBe(testPrincipalId);
    expect(owner!.treePath).toBe("owned.path");
  });

  test("setTreeOwner upserts on conflict", async () => {
    const db = createEngineDB(sql, schema);
    const otherPrincipal = await db.createUser({ name: "other-owner" });

    await db.setTreeOwner(testPrincipalId, "upsert.owned");
    await db.setTreeOwner(otherPrincipal.id, "upsert.owned");

    const owner = await db.getTreeOwner("upsert.owned");
    expect(owner!.userId).toBe(otherPrincipal.id);
  });

  test("removeTreeOwner removes ownership", async () => {
    const db = createEngineDB(sql, schema);
    await db.setTreeOwner(testPrincipalId, "remove.owned");
    const result = await db.removeTreeOwner("remove.owned");

    expect(result).toBe(true);

    const owner = await db.getTreeOwner("remove.owned");
    expect(owner).toBeNull();
  });

  test("listTreeOwners returns owners for principal", async () => {
    const db = createEngineDB(sql, schema);
    await db.setTreeOwner(testPrincipalId, "list.owned");

    const owners = await db.listTreeOwners(testPrincipalId);
    expect(owners.length).toBeGreaterThan(0);
  });

  test("isOwnerOf checks ownership", async () => {
    const db = createEngineDB(sql, schema);
    await db.setTreeOwner(testPrincipalId, "isowner.path");

    const isOwner = await db.isOwnerOf(testPrincipalId, "isowner.path.child");
    expect(isOwner).toBe(true);

    const isNotOwner = await db.isOwnerOf(testPrincipalId, "other.path");
    expect(isNotOwner).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Role Tests
// ---------------------------------------------------------------------------
describe("role ops", () => {
  let roleId: string;
  let memberId: string;

  beforeAll(async () => {
    const db = createEngineDB(sql, schema);
    // Create a role (a principal used as a role for grouping)
    const role = await db.createUser({
      name: "membership-role",
    });
    roleId = role.id;

    const member = await db.createUser({ name: "role-member" });
    memberId = member.id;
  });

  test("addRoleMember adds member to role", async () => {
    const db = createEngineDB(sql, schema);
    await db.addRoleMember(roleId, memberId);

    const members = await db.listRoleMembers(roleId);
    expect(members.length).toBeGreaterThan(0);
    expect(members.some((m) => m.memberId === memberId)).toBe(true);
  });

  test("addRoleMember detects cycles", async () => {
    const db = createEngineDB(sql, schema);
    const role1 = await db.createUser({
      name: "cycle-role-1",
    });
    const role2 = await db.createUser({
      name: "cycle-role-2",
    });

    await db.addRoleMember(role1.id, role2.id);

    // Try to create cycle: role2 -> role1 (but role1 -> role2 exists)
    await expect(db.addRoleMember(role2.id, role1.id)).rejects.toThrow(
      "would create a cycle",
    );
  });

  test("removeRoleMember removes member from role", async () => {
    const db = createEngineDB(sql, schema);
    const role = await db.createUser({
      name: "remove-role",
    });
    const member = await db.createUser({ name: "remove-member" });

    await db.addRoleMember(role.id, member.id);
    const result = await db.removeRoleMember(role.id, member.id);

    expect(result).toBe(true);

    const members = await db.listRoleMembers(role.id);
    expect(members.some((m) => m.memberId === member.id)).toBe(false);
  });

  test("listRolesForUser returns roles", async () => {
    const db = createEngineDB(sql, schema);
    const roles = await db.listRolesForUser(memberId);

    expect(roles.some((r) => r.id === roleId)).toBe(true);
  });

  test("hasAdminOption checks admin option", async () => {
    const db = createEngineDB(sql, schema);
    const role = await db.createUser({
      name: "admin-role",
    });
    const admin = await db.createUser({ name: "admin-member" });

    await db.addRoleMember(role.id, admin.id, true);

    const hasAdmin = await db.hasAdminOption(admin.id, role.id);
    expect(hasAdmin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Memory Tests
// ---------------------------------------------------------------------------
describe("memory ops", () => {
  let testPrincipalId: string;

  beforeAll(async () => {
    const db = createEngineDB(sql, schema);
    // Create a superuser for memory tests (bypasses RLS)
    const superuser = await db.createSuperuser("memory-test-admin");
    testPrincipalId = superuser.id;
  });

  test("createMemory creates a memory", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const memory = await db.createMemory({
      content: "Test memory content",
      meta: { key: "value" },
      tree: "test.memories",
    });

    expect(memory.id).toBeDefined();
    expect(memory.content).toBe("Test memory content");
    expect(memory.meta).toEqual({ key: "value" });
    expect(memory.tree).toBe("test.memories");
    expect(memory.hasEmbedding).toBe(false);
    expect(memory.createdAt).toBeInstanceOf(Date);
  });

  test("createMemory with temporal point-in-time", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const now = new Date();
    const memory = await db.createMemory({
      content: "Point in time memory",
      temporal: { start: now },
    });

    expect(memory.temporal).not.toBeNull();
    expect(memory.temporal!.start.getTime()).toBe(
      memory.temporal!.end.getTime(),
    );
  });

  test("createMemory with temporal range", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const start = new Date("2024-01-01");
    const end = new Date("2024-01-02");
    const memory = await db.createMemory({
      content: "Range memory",
      temporal: { start, end },
    });

    expect(memory.temporal).not.toBeNull();
    expect(memory.temporal!.start.getTime()).toBe(start.getTime());
  });

  test("getMemory returns memory by ID", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const created = await db.createMemory({ content: "Get test" });
    const fetched = await db.getMemory(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.content).toBe("Get test");
  });

  test("updateMemory updates content", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const created = await db.createMemory({ content: "Original" });
    const updated = await db.updateMemory(created.id, { content: "Updated" });

    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("Updated");
  });

  test("updateMemory updates meta", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const created = await db.createMemory({
      content: "Meta test",
      meta: { old: true },
    });
    const updated = await db.updateMemory(created.id, { meta: { new: true } });

    expect(updated!.meta).toEqual({ new: true });
  });

  test("deleteMemory removes memory", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const created = await db.createMemory({ content: "Delete test" });
    const result = await db.deleteMemory(created.id);

    expect(result).toBe(true);

    const fetched = await db.getMemory(created.id);
    expect(fetched).toBeNull();
  });

  test("deleteTree removes memories under path", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({ content: "Tree 1", tree: "delete.tree.a" });
    await db.createMemory({ content: "Tree 2", tree: "delete.tree.b" });
    await db.createMemory({ content: "Other", tree: "other.tree" });

    const result = await db.deleteTree("delete.tree");

    expect(result.count).toBe(2);
  });

  test("moveTree moves memories to new path", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const m1 = await db.createMemory({
      content: "Move 1",
      tree: "move.source",
    });
    const m2 = await db.createMemory({
      content: "Move 2",
      tree: "move.source.child",
    });

    const result = await db.moveTree("move.source", "move.destination");

    expect(result.count).toBe(2);

    const fetched1 = await db.getMemory(m1.id);
    expect(fetched1!.tree).toBe("move.destination");

    const fetched2 = await db.getMemory(m2.id);
    expect(fetched2!.tree).toBe("move.destination.child");
  });

  test("moveTree dry-run counts without moving", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const m1 = await db.createMemory({
      content: "DryMove 1",
      tree: "drymove.source",
    });
    const m2 = await db.createMemory({
      content: "DryMove 2",
      tree: "drymove.source.child",
    });

    // Dry-run preview uses countTree (same as RPC handler)
    const preview = await db.countTree("drymove.source");
    expect(preview.count).toBe(2);

    // Verify memories were NOT moved
    const fetched1 = await db.getMemory(m1.id);
    expect(fetched1!.tree).toBe("drymove.source");

    const fetched2 = await db.getMemory(m2.id);
    expect(fetched2!.tree).toBe("drymove.source.child");
  });

  test("countTree returns accurate count above 1000 (TNT-59 regression)", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    // Insert 1500 memories under a tree path. The bug capped the dry-run
    // count at 1000 because the handler used searchMemories with limit:1000.
    const total = 1500;
    const batchSize = 500;
    for (let start = 0; start < total; start += batchSize) {
      const batch = Array.from({ length: batchSize }, (_, i) => ({
        content: `Bulk ${start + i}`,
        tree: "bulk.count.regression",
      }));
      await db.batchCreateMemories(batch);
    }

    // Sanity: searchMemories with limit:1000 (the old, buggy preview) caps at 1000.
    const cappedPreview = await db.searchMemories({
      tree: "bulk.count.regression",
      limit: 1000,
    });
    expect(cappedPreview.total).toBe(1000);

    // countTree returns the true count, unbounded.
    const count = await db.countTree("bulk.count.regression");
    expect(count.count).toBe(total);

    // Cleanup so subsequent tree-related tests aren't affected.
    const deleted = await db.deleteTree("bulk.count.regression");
    expect(deleted.count).toBe(total);
  });

  test("countTree includes descendants and is empty for unknown paths", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({ content: "A", tree: "count.tree" });
    await db.createMemory({ content: "B", tree: "count.tree.child" });
    await db.createMemory({ content: "C", tree: "count.tree.child.deep" });
    await db.createMemory({ content: "D", tree: "count.other" });

    const inside = await db.countTree("count.tree");
    expect(inside.count).toBe(3);

    const empty = await db.countTree("count.does.not.exist");
    expect(empty.count).toBe(0);
  });

  test("batchCreateMemories creates multiple memories", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const ids = await db.batchCreateMemories([
      { content: "Batch 1", tree: "batch" },
      { content: "Batch 2", tree: "batch" },
      { content: "Batch 3", tree: "batch" },
    ]);

    expect(ids).toHaveLength(3);

    for (const id of ids) {
      const memory = await db.getMemory(id);
      expect(memory).not.toBeNull();
    }
  });

  test("getTree returns tree structure", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({ content: "Tree test 1", tree: "gettree.a.b" });
    await db.createMemory({ content: "Tree test 2", tree: "gettree.a.c" });

    const tree = await db.getTree({ tree: "gettree" });

    expect(tree.length).toBeGreaterThan(0);
    expect(tree.some((n) => n.path === "gettree.a")).toBe(true);
  });

  test("searchMemories with filter-only returns results", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    // Create test memories
    await db.createMemory({
      content: "Filter search test 1",
      tree: "search.filter",
      meta: { type: "test" },
    });
    await db.createMemory({
      content: "Filter search test 2",
      tree: "search.filter",
      meta: { type: "test" },
    });

    const result = await db.searchMemories({
      tree: "search.filter",
      limit: 10,
    });

    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect(result.results[0]!.score).toBe(1.0); // Filter-only uses score 1.0
  });

  test("searchMemories with meta filter", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({
      content: "Meta filter test",
      tree: "search.meta",
      meta: { category: "important", priority: 1 },
    });
    await db.createMemory({
      content: "Meta filter other",
      tree: "search.meta",
      meta: { category: "other" },
    });

    const result = await db.searchMemories({
      meta: { category: "important" },
      limit: 10,
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.content === "Meta filter test")).toBe(
      true,
    );
  });

  test("searchMemories with fulltext (BM25)", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({
      content: "PostgreSQL is a powerful relational database",
      tree: "search.bm25",
    });
    await db.createMemory({
      content: "Redis is an in-memory key-value store",
      tree: "search.bm25",
    });

    const result = await db.searchMemories({
      fulltext: "PostgreSQL database",
      limit: 10,
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.content).toContain("PostgreSQL");
    expect(result.results[0]!.score).toBeGreaterThan(0);
  });

  test("searchMemories with tree pattern (lquery)", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({
      content: "Lquery test a.b",
      tree: "lquery.a.b",
    });
    await db.createMemory({
      content: "Lquery test a.c",
      tree: "lquery.a.c",
    });
    await db.createMemory({
      content: "Lquery test other",
      tree: "other.path",
    });

    const result = await db.searchMemories({
      tree: "lquery.*",
      limit: 10,
    });

    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect(result.results.every((r) => r.tree.startsWith("lquery"))).toBe(true);
  });

  test("searchMemories with temporal contains filter", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    const jan1 = new Date("2024-01-01");
    const jan15 = new Date("2024-01-15");
    const feb1 = new Date("2024-02-01");

    await db.createMemory({
      content: "January event",
      tree: "search.temporal",
      temporal: { start: jan1, end: feb1 },
    });
    await db.createMemory({
      content: "Point in time event",
      tree: "search.temporal",
      temporal: { start: jan15 },
    });

    // Search for events containing Jan 10
    const result = await db.searchMemories({
      temporal: { contains: new Date("2024-01-10") },
      limit: 10,
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.content === "January event")).toBe(
      true,
    );
  });

  test("searchMemories orderBy asc/desc", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    // Create memories with slight delay to ensure different timestamps
    const m1 = await db.createMemory({
      content: "Order test first",
      tree: "search.order",
    });
    const m2 = await db.createMemory({
      content: "Order test second",
      tree: "search.order",
    });

    // Descending (default) - newest first
    const descResult = await db.searchMemories({
      tree: "search.order",
      orderBy: "desc",
      limit: 10,
    });
    expect(descResult.results[0]!.id).toBe(m2.id);

    // Ascending - oldest first
    const ascResult = await db.searchMemories({
      tree: "search.order",
      orderBy: "asc",
      limit: 10,
    });
    expect(ascResult.results[0]!.id).toBe(m1.id);
  });

  test("searchMemories with grep filter", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({
      content: "Error code ERR-42 occurred in production",
      tree: "search.grep",
    });
    await db.createMemory({
      content: "Warning code WARN-7 in staging",
      tree: "search.grep",
    });
    await db.createMemory({
      content: "All systems operational",
      tree: "search.grep",
    });

    // Regex matching "ERR-\d+" should only return the first memory
    const result = await db.searchMemories({
      grep: "ERR-\\d+",
      tree: "search.grep",
      limit: 10,
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0]!.content).toContain("ERR-42");
  });

  test("searchMemories with grep + fulltext", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({
      content: "PostgreSQL version 18.1 released with new features",
      tree: "search.grepfull",
    });
    await db.createMemory({
      content: "PostgreSQL conference announced for next year",
      tree: "search.grepfull",
    });

    // BM25 matches both on "PostgreSQL", but grep narrows to version pattern
    const result = await db.searchMemories({
      fulltext: "PostgreSQL",
      grep: "version \\d+\\.\\d+",
      limit: 10,
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0]!.content).toContain("version 18.1");
  });

  test("searchMemories grep is case-insensitive", async () => {
    const db = createEngineDB(sql, schema);
    db.setUser(testPrincipalId);

    await db.createMemory({
      content: "TypeScript is great",
      tree: "search.grepcase",
    });
    await db.createMemory({
      content: "typescript lowercase",
      tree: "search.grepcase",
    });

    // Case-insensitive: matches both "TypeScript" and "typescript"
    const result = await db.searchMemories({
      grep: "TypeScript",
      tree: "search.grepcase",
      limit: 10,
    });

    expect(result.results.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Transaction Tests
// ---------------------------------------------------------------------------
describe("withTransaction", () => {
  test("executes multiple ops atomically", async () => {
    const db = createEngineDB(sql, schema);
    const superuser = await db.createSuperuser("tx-test-admin");
    db.setUser(superuser.id);

    const result = await db.withTransaction("write", async (txDb) => {
      const m1 = await txDb.createMemory({
        content: "TX Memory 1",
        tree: "tx",
      });
      const m2 = await txDb.createMemory({
        content: "TX Memory 2",
        tree: "tx",
      });
      return [m1.id, m2.id];
    });

    expect(result).toHaveLength(2);

    // Verify both were created
    for (const id of result) {
      const memory = await db.getMemory(id);
      expect(memory).not.toBeNull();
    }
  });

  test("rolls back on error", async () => {
    const db = createEngineDB(sql, schema);
    const superuser = await db.createSuperuser("rollback-test-admin");
    db.setUser(superuser.id);

    let createdId: string | null = null;

    try {
      await db.withTransaction("write", async (txDb) => {
        const m = await txDb.createMemory({
          content: "Rollback test",
          tree: "rollback",
        });
        createdId = m.id;
        throw new Error("Intentional error");
      });
    } catch {
      // Expected
    }

    // Memory should not exist (rolled back)
    if (createdId) {
      const memory = await db.getMemory(createdId);
      expect(memory).toBeNull();
    }
  });
});
