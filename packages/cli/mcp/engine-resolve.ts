/**
 * Pure helpers for resolving a user-supplied engine reference against an
 * already-fetched engine list. Extracted so tests can exercise the matching
 * logic without booting the MCP server.
 */
import type { EngineInfo } from "../commands/engine.ts";

export function matchesIdentity(e: EngineInfo, arg: string): boolean {
  return e.slug === arg || e.id === arg || e.name === arg;
}

export function inOrg(e: EngineInfo, org: string): boolean {
  return e.orgSlug === org || e.orgId === org || e.orgName === org;
}

// MCP tools cannot ask follow-up questions, so this throws on ambiguity
// rather than prompting like the interactive `me engine use` CLI does.
export function resolveEngineForSession(
  engines: EngineInfo[],
  arg: string,
  org: string | undefined,
): EngineInfo {
  const scoped = org ? engines.filter((e) => inOrg(e, org)) : engines;

  const exact = scoped.filter((e) => matchesIdentity(e, arg));
  const [exactFirst] = exact;
  if (exact.length === 1 && exactFirst) return exactFirst;
  if (exact.length > 1) {
    const choices = exact.map((e) => `${e.orgSlug}:${e.slug}`).join(", ");
    throw new Error(
      `Ambiguous engine '${arg}'. Matches: ${choices}. ` +
        "Disambiguate by passing the org argument or use the engine id.",
    );
  }

  const lower = arg.toLowerCase();
  const fuzzy = scoped.filter(
    (e) =>
      e.slug.toLowerCase().includes(lower) ||
      e.name.toLowerCase().includes(lower),
  );
  const [fuzzyFirst] = fuzzy;
  if (fuzzy.length === 1 && fuzzyFirst) return fuzzyFirst;
  if (fuzzy.length > 1) {
    const choices = fuzzy
      .slice(0, 5)
      .map((e) => `${e.orgSlug}:${e.slug}`)
      .join(", ");
    throw new Error(
      `'${arg}' matches multiple engines: ${choices}. ` +
        "Use a more specific slug or pass the org argument.",
    );
  }
  throw new Error(
    `No engine matches '${arg}'${org ? ` in org '${org}'` : ""}. ` +
      "Call me_engine_list to see what's available.",
  );
}
