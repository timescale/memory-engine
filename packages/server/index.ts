// packages/server/index.ts
import { createAccountsDB } from "@memory-engine/accounts";
import {
  configure,
  info,
  reportError,
  withSpan,
} from "@memory-engine/telemetry";
import { checkRateLimit, checkSizeLimit } from "./middleware";
import { createRouter } from "./router";
import { internalError } from "./util/response";

// Initialize telemetry before starting server
await configure();

// =============================================================================
// Environment Variables
// =============================================================================

const port = process.env.PORT || 3000;

const accountsDatabaseUrl = process.env.ACCOUNTS_DATABASE_URL;
if (!accountsDatabaseUrl) {
  throw new Error("ACCOUNTS_DATABASE_URL environment variable is required");
}

const accountsMasterKey = process.env.ACCOUNTS_MASTER_KEY;
if (!accountsMasterKey) {
  throw new Error("ACCOUNTS_MASTER_KEY environment variable is required");
}

const engineDatabaseUrl = process.env.ENGINE_DATABASE_URL;
if (!engineDatabaseUrl) {
  throw new Error("ENGINE_DATABASE_URL environment variable is required");
}

const accountsSchema = process.env.ACCOUNTS_SCHEMA || "accounts";

// =============================================================================
// Database Pools
// =============================================================================

// Parse master key from hex string to Buffer
const masterKeyBuffer = Buffer.from(accountsMasterKey, "hex");
if (masterKeyBuffer.length !== 32) {
  throw new Error(
    "ACCOUNTS_MASTER_KEY must be a 32-byte (64 character) hex string",
  );
}

// Create database connections
const accountsSql = new Bun.SQL(accountsDatabaseUrl);
const engineSql = new Bun.SQL(engineDatabaseUrl);

// Create accounts DB with operations layer
const accountsDb = createAccountsDB(accountsSql, accountsSchema, {
  masterKey: masterKeyBuffer,
});

// =============================================================================
// Router
// =============================================================================

const router = createRouter({ accountsDb, engineSql });

// =============================================================================
// Server
// =============================================================================

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    return withSpan(
      "http.request",
      {
        "http.method": method,
        "http.url": request.url,
        "http.path": path,
      },
      async () => {
        try {
          // 1. Check size limit
          const sizeError = checkSizeLimit(request);
          if (sizeError) {
            return sizeError;
          }

          // 2. Check rate limit
          const rateLimitError = checkRateLimit(request);
          if (rateLimitError) {
            return rateLimitError;
          }

          // 3. Route and handle request
          return await router.handleRequest(request);
        } catch (error) {
          reportError("Request failed", error as Error, {
            "http.method": method,
            "http.path": path,
          });
          return internalError();
        }
      },
    );
  },
});

info("Server started", { port });
