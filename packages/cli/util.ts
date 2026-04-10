/**
 * Shared CLI utilities.
 *
 * Common patterns used across multiple command files:
 * - Session token validation
 * - Org auto-resolution
 * - Error handling
 */
import * as clack from "@clack/prompts";
import type { AccountsClient } from "@memory-engine/client";
import { RpcError } from "@memory-engine/client";
import type { ResolvedCredentials } from "./credentials.ts";
import type { OutputFormat } from "./output.ts";
import { output } from "./output.ts";

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
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
      },
      fmt,
      () => {},
    );
  }
  process.exit(1);
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
