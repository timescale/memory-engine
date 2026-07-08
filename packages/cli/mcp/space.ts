import { createUserClient } from "../client.ts";
import { userBearer } from "../session.ts";

const SPACE_SLUG_RE = /^[a-z0-9]{12}$/;

interface ListedSpace {
  slug: string;
  name: string;
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
