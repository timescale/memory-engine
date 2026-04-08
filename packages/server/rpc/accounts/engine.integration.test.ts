/**
 * Integration tests for engine provisioning via RPC.
 *
 * Tests that engine.create properly:
 * 1. Creates engine record with correct language
 * 2. Provisions schema in the engine database
 * 3. Defaults language to "english" when not specified
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AccountsDB,
  createAccountsDB,
  type Identity,
} from "@memory-engine/accounts";
import { TestDatabase as AccountsTestDatabase } from "@memory-engine/accounts/migrate/test-utils";
import { bootstrap } from "@memory-engine/engine/migrate/bootstrap";
import { TestDatabase as EngineTestDatabase } from "@memory-engine/engine/migrate/test-utils";
import { SQL } from "bun";
import type { HandlerContext } from "../types";
import { engineMethods } from "./engine";
import type { AccountsRpcContext } from "./types";

// Test master key (32 bytes for AES-256)
const TEST_MASTER_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf-8",
);

// Test fixtures
let accountsTestDb: AccountsTestDatabase;
let engineTestDb: EngineTestDatabase;
let accountsDb: AccountsDB;
let engineSql: SQL;
let engineConnectionString: string;

// Test data
let testOrgId: string;
let testIdentity: Identity;

beforeAll(async () => {
  // Set up accounts database
  accountsTestDb = await AccountsTestDatabase.create();
  accountsDb = createAccountsDB(accountsTestDb.sql, accountsTestDb.schema, {
    masterKey: TEST_MASTER_KEY,
  });

  // Create and activate encryption key
  const keyId = await accountsDb.createDataKey();
  await accountsDb.activateDataKey(keyId);

  // Set up engine database
  engineTestDb = new EngineTestDatabase();
  engineConnectionString = await engineTestDb.create();
  engineSql = new SQL(engineConnectionString);

  // Bootstrap the engine database (extensions, roles)
  await bootstrap(engineSql);

  // Create test identity and org
  testIdentity = await accountsDb.createIdentity({
    email: "engine-test@example.com",
    name: "Engine Test User",
  });

  const org = await accountsDb.createOrg({
    slug: "engine-test-org",
    name: "Engine Test Org",
  });
  testOrgId = org.id;

  // Make identity an owner of the org
  await accountsDb.addMember(org.id, testIdentity.id, "owner");
});

afterAll(async () => {
  await engineSql.close();
  await engineTestDb.drop();
  await accountsTestDb.dispose();
});

/**
 * Helper to create a context for engine methods.
 */
function createContext(identity: Identity): HandlerContext {
  return {
    request: new Request("http://localhost"),
    db: accountsDb,
    identity,
    engineSql,
    appVersion: "0.1.0",
  } as unknown as AccountsRpcContext;
}

/**
 * Helper to check if a schema exists.
 */
async function schemaExists(sql: SQL, name: string): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from information_schema.schemata
      where schema_name = ${name}
    ) as exists
  `;
  return row.exists;
}

/**
 * Helper to check if a table exists in a schema.
 */
async function tableExists(
  sql: SQL,
  schema: string,
  table: string,
): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = ${table}
    ) as exists
  `;
  return row.exists;
}

/**
 * Helper to extract the text_config from the BM25 index definition.
 * The config is embedded in the index during migration, not stored in a table.
 */
async function getBm25TextConfig(
  sql: SQL,
  schema: string,
): Promise<string | null> {
  try {
    const [row] = await sql`
      select pg_get_indexdef(indexrelid) as def
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema}
        and c.relname = 'memory_content_bm25_idx'
    `;
    if (!row?.def) return null;

    // Extract text_config from: "... WITH (text_config=english, ..." (no quotes)
    const match = row.def.match(/text_config=(\w+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine Provisioning Tests
// ---------------------------------------------------------------------------

describe("engine.create integration", () => {
  test("creates engine record with default language (english)", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    const context = createContext(testIdentity);
    const result = (await handler(
      { orgId: testOrgId, name: "Default Language Engine" },
      context,
    )) as { id: string; slug: string; language: string };

    // Verify engine record
    expect(result.id).toBeDefined();
    expect(result.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(result.language).toBe("english");

    // Verify schema was provisioned
    const schema = `me_${result.slug}`;
    expect(await schemaExists(engineSql, schema)).toBe(true);

    // Verify core tables exist
    expect(await tableExists(engineSql, schema, "memory")).toBe(true);
    expect(await tableExists(engineSql, schema, "user")).toBe(true);
    expect(await tableExists(engineSql, schema, "api_key")).toBe(true);
    expect(await tableExists(engineSql, schema, "version")).toBe(true);
    expect(await tableExists(engineSql, schema, "migration")).toBe(true);

    // Verify config has correct bm25_text_config
    expect(await getBm25TextConfig(engineSql, schema)).toBe("english");
  });

  test("creates engine record with custom language (german)", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    const context = createContext(testIdentity);
    const result = (await handler(
      { orgId: testOrgId, name: "German Engine", language: "german" },
      context,
    )) as { id: string; slug: string; language: string };

    // Verify engine record
    expect(result.id).toBeDefined();
    expect(result.language).toBe("german");

    // Verify schema was provisioned
    const schema = `me_${result.slug}`;
    expect(await schemaExists(engineSql, schema)).toBe(true);

    // Verify config has correct bm25_text_config
    expect(await getBm25TextConfig(engineSql, schema)).toBe("german");
  });

  test("creates engine record with simple language (simple)", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    const context = createContext(testIdentity);
    const result = (await handler(
      { orgId: testOrgId, name: "Simple Engine", language: "simple" },
      context,
    )) as { id: string; slug: string; language: string };

    // Verify engine record
    expect(result.language).toBe("simple");

    // Verify schema was provisioned with simple text config
    const schema = `me_${result.slug}`;
    expect(await getBm25TextConfig(engineSql, schema)).toBe("simple");
  });

  test("provisions schema with embedding_queue table", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    const context = createContext(testIdentity);
    const result = (await handler(
      { orgId: testOrgId, name: "Queue Test Engine" },
      context,
    )) as { slug: string };

    const schema = `me_${result.slug}`;
    expect(await tableExists(engineSql, schema, "embedding_queue")).toBe(true);
  });

  test("rejects non-member creating engine", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    // Create a new identity that is NOT a member of the org
    const outsider = await accountsDb.createIdentity({
      email: "outsider@example.com",
      name: "Outsider",
    });

    const context = createContext(outsider);

    await expect(
      handler({ orgId: testOrgId, name: "Unauthorized Engine" }, context),
    ).rejects.toThrow("Only owners and admins can create engines");
  });

  test("rejects member (non-admin) creating engine", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    // Create a new identity and add as regular member
    const member = await accountsDb.createIdentity({
      email: "member@example.com",
      name: "Regular Member",
    });
    await accountsDb.addMember(testOrgId, member.id, "member");

    const context = createContext(member);

    await expect(
      handler({ orgId: testOrgId, name: "Member Engine" }, context),
    ).rejects.toThrow("Only owners and admins can create engines");
  });

  test("admin can create engine", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    // Create a new identity and add as admin
    const admin = await accountsDb.createIdentity({
      email: "admin@example.com",
      name: "Admin User",
    });
    await accountsDb.addMember(testOrgId, admin.id, "admin");

    const context = createContext(admin);

    const result = (await handler(
      { orgId: testOrgId, name: "Admin Engine" },
      context,
    )) as { id: string; slug: string };

    expect(result.id).toBeDefined();
    const schema = `me_${result.slug}`;
    expect(await schemaExists(engineSql, schema)).toBe(true);
  });

  test("engine record is persisted in accounts database", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    const context = createContext(testIdentity);
    const result = (await handler(
      { orgId: testOrgId, name: "Persisted Engine" },
      context,
    )) as { id: string; slug: string; language: string };

    // Verify we can fetch the engine from the accounts DB
    const engine = await accountsDb.getEngine(result.id);
    expect(engine).not.toBeNull();
    expect(engine?.name).toBe("Persisted Engine");
    expect(engine?.orgId).toBe(testOrgId);
    expect(engine?.status).toBe("active");
    expect(engine?.language).toBe("english");
  });

  test("engine can be retrieved by slug after creation", async () => {
    const handler = engineMethods.get("engine.create")?.handler;
    if (!handler) throw new Error("engine.create handler not found");

    const context = createContext(testIdentity);
    const result = (await handler(
      { orgId: testOrgId, name: "Slug Lookup Engine" },
      context,
    )) as { id: string; slug: string };

    // Verify we can fetch the engine by slug
    const engine = await accountsDb.getEngineBySlug(result.slug);
    expect(engine).not.toBeNull();
    expect(engine?.id).toBe(result.id);
  });
});
