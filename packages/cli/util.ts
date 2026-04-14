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

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolve an org from a flag, positional argument, or auto-resolution.
 *
 * Accepts a UUID, name, or slug. Falls back to auto-resolution if only one org.
 * Priority: positionalArg > flagValue > auto-resolve (if exactly one org).
 * Exits with an error if the org cannot be determined.
 */
export async function resolveOrg(
  accounts: AccountsClient,
  fmt: OutputFormat,
  flagValue?: string,
  positionalArg?: string,
): Promise<OrgInfo> {
  const { orgs } = await accounts.org.list();
  const input = positionalArg ?? flagValue;

  if (input) {
    // Try UUID match first
    if (UUIDV7_RE.test(input)) {
      const match = orgs.find((o) => o.id === input);
      if (match) return match;
      // Might be a valid org ID the user isn't a member of — use it as-is
      return { id: input, name: input, slug: input };
    }

    // Match by name or slug (case-insensitive)
    const lower = input.toLowerCase();
    const matches = orgs.filter(
      (o) => o.name.toLowerCase() === lower || o.slug.toLowerCase() === lower,
    );

    if (matches.length === 1 && matches[0]) return matches[0];

    if (matches.length === 0) {
      const msg = `No organization found matching '${input}'.`;
      if (fmt === "text") {
        clack.log.error(msg);
        if (orgs.length > 0) {
          console.log("  Your organizations:");
          for (const org of orgs) {
            console.log(`    ${org.name} (${org.slug})`);
          }
        }
      } else {
        output({ error: msg, orgs }, fmt, () => {});
      }
      process.exit(1);
    }

    // Multiple matches (same name, different orgs)
    const msg = `Multiple organizations match '${input}'. Use the org ID instead:`;
    if (fmt === "text") {
      clack.log.error(msg);
      for (const org of matches) {
        console.log(`  ${org.name} (${org.slug}) — ${org.id}`);
      }
    } else {
      output({ error: msg, orgs: matches }, fmt, () => {});
    }
    process.exit(1);
  }

  // Auto-resolve: pick if exactly one
  if (orgs.length === 1 && orgs[0]) return orgs[0];

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
    "You belong to multiple organizations. Use --org <name-or-id> to specify which one.";
  if (fmt === "text") {
    clack.log.error(msg);
    for (const org of orgs) {
      console.log(`  ${org.name} (${org.slug}) — ${org.id}`);
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
 * Resolve an org ID from a flag, positional argument, or auto-resolution.
 *
 * Convenience wrapper around resolveOrg — returns just the ID.
 */
export async function resolveOrgId(
  accounts: AccountsClient,
  fmt: OutputFormat,
  flagValue?: string,
  positionalArg?: string,
): Promise<string> {
  const org = await resolveOrg(accounts, fmt, flagValue, positionalArg);
  return org.id;
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
 * Resolve an identity ID from an email, name, or UUID.
 *
 * - UUID: used as-is
 * - Email (contains @): looked up via identity.getByEmail
 * - Otherwise: error with guidance
 */
export async function resolveIdentityId(
  accounts: AccountsClient,
  fmt: OutputFormat,
  input: string,
): Promise<string> {
  if (UUIDV7_RE.test(input)) return input;

  if (input.includes("@")) {
    const { identity } = await accounts.identity.getByEmail({ email: input });
    if (identity) return identity.id;

    const msg = `No identity found with email '${input}'. They may need to sign up first, or use 'me invitation create' to invite them.`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  const msg = `'${input}' is not a valid ID or email. Provide a UUID or email address.`;
  if (fmt === "text") {
    clack.log.error(msg);
  } else {
    output({ error: msg }, fmt, () => {});
  }
  process.exit(1);
}

/**
 * Resolve an identity from an org's member list by name, email, or UUID.
 *
 * Used for operations on existing members (e.g., remove).
 */
export async function resolveMember(
  accounts: AccountsClient,
  fmt: OutputFormat,
  orgId: string,
  input: string,
): Promise<{ identityId: string; name: string; email: string }> {
  const { members } = await accounts.org.member.list({ orgId });

  // UUID match
  if (UUIDV7_RE.test(input)) {
    const match = members.find((m) => m.identityId === input);
    if (match) return match;
    // UUID not in member list — return it as-is (server will error if invalid)
    return { identityId: input, name: input, email: "" };
  }

  // Email match
  if (input.includes("@")) {
    const lower = input.toLowerCase();
    const match = members.find((m) => m.email.toLowerCase() === lower);
    if (match) return match;

    const msg = `No member with email '${input}' in this organization.`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  // Name match
  const lower = input.toLowerCase();
  const matches = members.filter((m) => m.name.toLowerCase() === lower);

  if (matches.length === 1 && matches[0]) return matches[0];

  if (matches.length === 0) {
    const msg = `No member named '${input}' in this organization.`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  // Multiple matches
  const msg = `Multiple members named '${input}'. Use their email instead:`;
  if (fmt === "text") {
    clack.log.error(msg);
    for (const m of matches) {
      console.log(`  ${m.name} — ${m.email}`);
    }
  } else {
    output({ error: msg, members: matches }, fmt, () => {});
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
