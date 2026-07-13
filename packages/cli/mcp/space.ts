import { createUserClient, isRpcError } from "../client.ts";
import { userBearer } from "../session.ts";

const SPACE_SLUG_RE = /^[a-z0-9]{12}$/;

export interface ListedSpace {
  slug: string;
  name: string;
}

/**
 * Server error codes that can mean "the X-Me-Space is wrong". The space auth
 * middleware answers a bad/inaccessible/missing space with one of these:
 *   - MISSING_SPACE — no X-Me-Space header (400)
 *   - UNAUTHORIZED  — slug doesn't exist (401, deliberately generic to avoid
 *     space enumeration — so it's indistinguishable from a bad/expired token)
 *   - FORBIDDEN     — slug exists but this credential isn't a member (403)
 * These arrive as an HTTP-error body, not a JSON-RPC envelope, so the string
 * code lands in RpcError.code (not .data.code / .appCode). We only ever treat
 * this as a *candidate*: `spaceErrorHint` cross-checks with `space.list` and the
 * message is rewritten only when a concrete space problem is actually found.
 */
const SPACE_SHAPED_CODES = new Set([
  "MISSING_SPACE",
  "UNAUTHORIZED",
  "FORBIDDEN",
]);

/** True if `error` could be a wrong-space failure (see {@link SPACE_SHAPED_CODES}). */
export function isSpaceShapedError(error: unknown): boolean {
  if (!isRpcError(error)) return false;
  // Auth-layer failures carry the code in `.code` (a string, despite the
  // numeric type); genuine JSON-RPC app errors carry it in `.appCode`.
  return (
    (error.appCode !== undefined && SPACE_SHAPED_CODES.has(error.appCode)) ||
    SPACE_SHAPED_CODES.has(String(error.code))
  );
}

/**
 * Turn a failed tool-call error into a helpful space-specific message, or
 * `undefined` to leave the original error untouched.
 *
 * Only fires for a space-shaped error. It then probes `listSpaces` (the user
 * endpoint's `space.list`, allowed for every credential — user, PAT, or agent):
 *   - probe throws  → the credential itself is bad/expired, not the space →
 *     `undefined` (keep the original "Invalid credentials" message).
 *   - probe succeeds → `describeMcpSpaceProblem` pinpoints the problem, and
 *     returns `undefined` when the space is actually valid (so a genuine
 *     credential/tree-permission FORBIDDEN is never mislabelled as a space bug).
 */
export async function spaceErrorHint(options: {
  error: unknown;
  space: string;
  listSpaces: () => Promise<ListedSpace[]>;
}): Promise<string | undefined> {
  if (!isSpaceShapedError(options.error)) return undefined;
  let spaces: ListedSpace[];
  try {
    spaces = await options.listSpaces();
  } catch {
    return undefined;
  }
  return describeMcpSpaceProblem(options.space, spaces);
}

export function isSpaceSlug(space: string): boolean {
  return SPACE_SLUG_RE.test(space);
}

export function describeMcpSpaceProblem(
  space: string,
  spaces: ListedSpace[],
): string | undefined {
  if (spaces.some((s) => s.slug === space)) return undefined;

  const lower = space.toLowerCase();
  const nameMatches = spaces.filter((s) => s.name.toLowerCase() === lower);
  if (nameMatches.length === 1) {
    const match = nameMatches[0];
    if (match) {
      return `Space '${space}' is a display name, not a slug. Did you mean '${match.slug}'?`;
    }
  }

  if (nameMatches.length > 1) {
    const candidates = nameMatches
      .map((s) => `${s.name} (${s.slug})`)
      .join(", ");
    return `Space '${space}' is a display name used by multiple spaces. Use one of these slugs: ${candidates}.`;
  }

  if (isSpaceSlug(space)) {
    return `Space slug '${space}' was not found or is not accessible with this credential. Run 'me space list' to see available slugs.`;
  }

  return `--space must refer to a valid space slug, not a space name. Run 'me space list' to see available slugs.`;
}

export async function validateMcpSpace(options: {
  server: string;
  apiKey?: string;
  asAgent?: string;
  space: string;
}): Promise<string | undefined> {
  const user = createUserClient({
    url: options.server,
    ...userBearer(options.server, options.apiKey),
    asAgent: options.asAgent,
  });

  try {
    const { spaces } = await user.space.list();
    return describeMcpSpaceProblem(options.space, spaces);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not validate --space '${options.space}' with space.list: ${message}`;
  }
}
