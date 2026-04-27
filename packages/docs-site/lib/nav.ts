/**
 * Site navigation -- a hand-curated tree of links.
 *
 * Each entry maps a docs slug (the URL after the docs root) to a display
 * label. The slug equals the source markdown path under `docs/` with the
 * `.md` extension removed (e.g. `cli/me-memory.md` -> `cli/me-memory`).
 *
 * The home page is the empty string slug, rendered from `docs/index.md`.
 */

export type NavItem = { label: string; slug: string };
export type NavSection = { title: string; items: NavItem[] };

export const NAV: NavSection[] = [
  {
    title: "Guides",
    items: [
      { label: "Home", slug: "" },
      { label: "Getting Started", slug: "getting-started" },
      { label: "Core Concepts", slug: "concepts" },
      { label: "File Formats", slug: "formats" },
      { label: "Access Control", slug: "access-control" },
      { label: "Memory Packs", slug: "memory-packs" },
      { label: "MCP Integration", slug: "mcp-integration" },
      { label: "TypeScript Client", slug: "typescript-client" },
      { label: "Troubleshooting", slug: "troubleshooting" },
    ],
  },
  {
    title: "CLI Reference",
    items: [
      { label: "me login", slug: "cli/me-login" },
      { label: "me logout", slug: "cli/me-logout" },
      { label: "me whoami", slug: "cli/me-whoami" },
      { label: "me engine", slug: "cli/me-engine" },
      { label: "me memory", slug: "cli/me-memory" },
      { label: "me mcp", slug: "cli/me-mcp" },
      { label: "me claude", slug: "cli/me-claude" },
      { label: "me codex", slug: "cli/me-codex" },
      { label: "me gemini", slug: "cli/me-gemini" },
      { label: "me opencode", slug: "cli/me-opencode" },
      { label: "me serve", slug: "cli/me-serve" },
      { label: "Agent session imports", slug: "cli/agent-session-imports" },
      { label: "me user", slug: "cli/me-user" },
      { label: "me role", slug: "cli/me-role" },
      { label: "me grant", slug: "cli/me-grant" },
      { label: "me owner", slug: "cli/me-owner" },
      { label: "me org", slug: "cli/me-org" },
      { label: "me invitation", slug: "cli/me-invitation" },
      { label: "me apikey", slug: "cli/me-apikey" },
      { label: "me pack", slug: "cli/me-pack" },
      { label: "me completions", slug: "cli/me-completions" },
    ],
  },
  {
    title: "MCP Tools",
    items: [
      { label: "me_memory_create", slug: "mcp/me_memory_create" },
      { label: "me_memory_get", slug: "mcp/me_memory_get" },
      { label: "me_memory_search", slug: "mcp/me_memory_search" },
      { label: "me_memory_update", slug: "mcp/me_memory_update" },
      { label: "me_memory_delete", slug: "mcp/me_memory_delete" },
      { label: "me_memory_delete_tree", slug: "mcp/me_memory_delete_tree" },
      { label: "me_memory_tree", slug: "mcp/me_memory_tree" },
      { label: "me_memory_mv", slug: "mcp/me_memory_mv" },
      { label: "me_memory_import", slug: "mcp/me_memory_import" },
      { label: "me_memory_export", slug: "mcp/me_memory_export" },
    ],
  },
];

/**
 * Flat ordered list of all nav items, used to compute prev/next links.
 */
export const NAV_FLAT: NavItem[] = NAV.flatMap((section) => section.items);

/**
 * Look up the prev/next neighbors for a given slug.
 */
export function getNeighbors(slug: string): {
  prev: NavItem | null;
  next: NavItem | null;
} {
  const idx = NAV_FLAT.findIndex((item) => item.slug === slug);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: idx > 0 ? (NAV_FLAT[idx - 1] ?? null) : null,
    next: idx < NAV_FLAT.length - 1 ? (NAV_FLAT[idx + 1] ?? null) : null,
  };
}

/**
 * Build the URL for a slug. Empty slug -> "/", everything else -> "/<slug>/".
 */
export function slugToHref(slug: string): string {
  if (slug === "") return "/";
  return `/${slug}/`;
}

/**
 * Convert "/" or "/foo/bar/" back to a slug (matches markdown filenames).
 */
export function pathToSlug(pathname: string): string {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}
