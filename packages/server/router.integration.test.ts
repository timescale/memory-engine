// Integration coverage for user-RPC context assembly at the router boundary.
//
// A restricted PAT's metadata originates in authenticateUser, passes through
// createRouter, and must reach both space.list and the management-method gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { bootstrapSpaceDatabase, migrateCore } from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import {
  ACCESS,
  type CoreStore,
  coreStore,
  formatApiKey,
} from "@memory.build/engine/core";
import type { Sql } from "postgres";
import postgres from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import type { Auth } from "./auth/betterauth";
import type { ServerContext } from "./context";
import { createRouter, type Router } from "./router";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

const rand = (n: number) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let result = "";
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return result;
};

let sql: Sql;
let core: CoreStore;
let coreSchema: string;
let router: Router;

function userRpcRequest(token: string, method: string, params: unknown = {}) {
  return new Request("http://localhost/api/v1/user/rpc", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  coreSchema = `core_test_${rand(8)}`;
  await bootstrapSpaceDatabase(sql);
  await migrateCore(sql, { schema: coreSchema });
  core = coreStore(sql, coreSchema);

  const context: ServerContext = {
    db: sql,
    // The test uses only the API-key branch, which never reads better-auth.
    betterAuth: {} as Auth,
    verifyOAuthToken: async () => null,
    getUserEmailVerified: async () => true,
    core,
    authSchema: "auth",
    coreSchema,
    embeddingConfig: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
    } as EmbeddingConfig,
    apiBaseUrl: "https://test.example.com",
    webDist: "packages/web/dist",
    webAllowedOrigins: ["https://test.example.com"],
    serverVersion: SERVER_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
  };
  router = createRouter(context);
});

afterAll(async () => {
  await sql.unsafe(`drop schema if exists ${coreSchema} cascade`);
  await sql.end();
});

test("a restricted PAT keeps its space scope and cannot manage the account through the router", async () => {
  const [row] = await sql`select uuidv7() as id`;
  const userId = row?.id as string;
  await core.createUser(userId, `u_${rand(8)}@example.com`);

  const declaredSpaceId = await core.createSpace(rand(12), "Declared");
  const undeclaredSpaceId = await core.createSpace(rand(12), "Undeclared");
  await core.addPrincipalToSpace(declaredSpaceId, userId);
  await core.addPrincipalToSpace(undeclaredSpaceId, userId);

  const key = await core.createApiKey(userId, "scoped-pat", {
    access: [
      {
        spaceId: declaredSpaceId,
        grants: [{ treePath: "share", access: ACCESS.read }],
      },
    ],
  });
  const token = formatApiKey(key.lookupId, key.secret);

  const listResponse = await router.handleRequest(
    userRpcRequest(token, "space.list"),
  );
  expect(listResponse.status).toBe(200);
  const listBody = (await listResponse.json()) as {
    result: { spaces: Array<{ id: string }> };
  };
  expect(listBody.result.spaces.map((space) => space.id)).toEqual([
    declaredSpaceId,
  ]);

  const managementResponse = await router.handleRequest(
    userRpcRequest(token, "serviceAccount.list"),
  );
  expect(managementResponse.status).toBe(200);
  const managementBody = (await managementResponse.json()) as {
    error?: { data?: { code?: string } };
  };
  expect(managementBody.error?.data?.code).toBe("FORBIDDEN");
});
