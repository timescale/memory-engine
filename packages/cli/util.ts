/**
 * Shared CLI utilities.
 *
 * Common patterns used across multiple command files:
 * - Session token validation
 * - Engine/API key validation
 * - Org auto-resolution
 * - Error handling
 */
import * as clack from "@clack/prompts";
import type { AccountsClient, EngineClient } from "@memory-engine/client";
import { RpcError } from "@memory-engine/client";
import type { ResolvedCredentials } from "./credentials.ts";
import type { OutputFormat } from "./output.ts";
import { output } from "./output.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Ensure the user has a session token. Exits with an error if not.
 */
export function requireSession(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): asserts creds is ResolvedCredentials & { sessionToken: string } {
  if (!creds.sessionToken) {
    if (fmt === "text") {
      clack.log.error("Not logged in. Run 'me login' first.");
    } else {
      output({ error: "Not logged in" }, fmt, () => {});
    }
    process.exit(1);
  }
}

/**
 * Ensure the user has an active engine with an API key. Exits with an error if not.
 */
export function requireEngine(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): asserts creds is ResolvedCredentials & { apiKey: string } {
  if (!creds.apiKey) {
    if (fmt === "text") {
      clack.log.error("No active engine. Run 'me engine use' to select one.");
    } else {
      output({ error: "No active engine" }, fmt, () => {});
    }
    process.exit(1);
  }
}

/**
 * Resolve an org ID from a flag, positional argument, or auto-resolution.
 *
 * Priority: positionalArg > flagValue > auto-resolve (if exactly one org).
 * Exits with an error if the org cannot be determined.
 */
export async function resolveOrgId(
  accounts: AccountsClient,
  fmt: OutputFormat,
  flagValue?: string,
  positionalArg?: string,
): Promise<string> {
  // Positional arg takes priority
  if (positionalArg) return positionalArg;

  // Then --org flag
  if (flagValue) return flagValue;

  // Auto-resolve: list orgs and pick if exactly one
  const { orgs } = await accounts.org.list();

  if (orgs.length === 1 && orgs[0]) {
    return orgs[0].id;
  }

  if (orgs.length === 0) {
    const msg = "You don't belong to any organizations.";
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  // Multiple orgs — can't auto-resolve
  const msg =
    "You belong to multiple organizations. Use --org <id> to specify which one.";
  if (fmt === "text") {
    clack.log.error(msg);
    for (const org of orgs) {
      console.log(`  ${org.name} — ${org.id}`);
    }
  } else {
    output(
      {
        error: msg,
        orgs: orgs.map((o: { id: string; name: string; slug: string }) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
        })),
      },
      fmt,
      () => {},
    );
  }
  process.exit(1);
}

/**
 * Resolve a user or role by ID or name. If the argument looks like a UUIDv7,
 * fetches by ID; otherwise fetches by name. Returns the UUID.
 */
export async function resolveUserId(
  engine: EngineClient,
  idOrName: string,
): Promise<string> {
  if (UUIDV7_RE.test(idOrName)) return idOrName;
  const user = await engine.user.getByName({ name: idOrName });
  return user.id;
}

/**
 * Handle an error from an RPC call. Formats per output mode and exits.
 */
export function handleError(error: unknown, fmt: OutputFormat): never {
  const msg =
    error instanceof RpcError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

  if (fmt === "text") {
    clack.log.error(msg);
  } else {
    output({ error: msg }, fmt, () => {});
  }
  process.exit(1);
}
