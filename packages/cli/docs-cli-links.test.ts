/**
 * Parity between the top-level CLI commands and their reference docs.
 *
 * Mirrors `mcp/docs-links.test.ts` (which links MCP tools ↔ `docs/mcp/*.md`)
 * for the CLI side, which has no other automated coverage. It statically
 * scans `index.ts` for the command factories it registers and checks each
 * against `docs/cli/`:
 *
 *   1. Every command factory registered in `index.ts` is accounted for in
 *      `COMMAND_DOCS` below. Catches: a new command added without a docs
 *      decision (author must map it to a page or explicitly to `null`).
 *   2. Every factory mapped to a page has a `docs/cli/<slug>.md` file.
 *      Catches: a documented command whose page was never written.
 *   3. Every `docs/cli/*.md` file is either a mapped page or an explicit
 *      non-command allowlist entry. Catches: orphaned docs (command removed
 *      or renamed but the page lingered).
 *
 * It is intentionally a source scan (not an import of `index.ts`, which runs
 * the CLI on import) so it stays fast and side-effect-free.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CLI_DIR = import.meta.dir;
const REPO_ROOT = resolve(CLI_DIR, "..", "..");
const INDEX_PATH = join(CLI_DIR, "index.ts");
const DOCS_CLI = join(REPO_ROOT, "docs", "cli");

const SOURCE = readFileSync(INDEX_PATH, "utf8");

/**
 * Command factory identifier → docs/cli slug, or `null` when the command is
 * intentionally not given its own page (documented within another page, or a
 * helper that isn't a user-facing command). Keys must stay in sync with the
 * `create…Command(s)` factories registered in `index.ts` (test #1 enforces it).
 */
const COMMAND_DOCS: Record<string, string | null> = {
  createLoginCommand: "me-login",
  createLogoutCommand: "me-logout",
  createWhoamiCommand: "me-whoami",
  createStatusCommand: "me-status",
  createVersionCommand: "me-version",
  createUpgradeCommand: "me-upgrade",
  createSpaceCommand: "me-space",
  createInviteCommand: "me-invite",
  createGroupCommand: "me-group",
  createAccessCommand: "me-access",
  createAgentCommand: "me-agent",
  createServiceCommand: "me-service",
  createApiKeyCommand: "me-apikey",
  createMemoryCommand: "me-memory",
  createMemoryAliasCommands: null, // top-level aliases documented in me-memory
  createImportCommand: "me-import",
  createMcpCommand: "me-mcp",
  createClaudeCommand: "me-claude",
  createOpenCodeCommand: "me-opencode",
  createGeminiCommand: "me-gemini",
  createCodexCommand: "me-codex",
  createProjectCommand: "me-project",
  createRemovedCommand: null, // helper for retired aliases, not a command
  createServeCommand: "me-serve",
  createPackCommand: "me-pack",
};

/**
 * `docs/cli/*.md` pages that are not backed by a command factory:
 *   - agent-session-imports: shared reference for the session importers
 *   - me-completions: registered inline in index.ts (not via a factory)
 */
const NON_COMMAND_DOCS = new Set(["agent-session-imports", "me-completions"]);

/** Factory identifiers (`create…Command` / `…Commands`) referenced in index.ts. */
const FOUND_FACTORIES = new Set(
  [...SOURCE.matchAll(/\bcreate[A-Z][A-Za-z0-9]*Commands?\b/g)].map(
    (m) => m[0],
  ),
);

describe("CLI doc parity", () => {
  test("index.ts registers at least one command factory (regex sanity)", () => {
    expect(FOUND_FACTORIES.size).toBeGreaterThan(0);
  });

  test("every command factory in index.ts is mapped in COMMAND_DOCS", () => {
    const unmapped = [...FOUND_FACTORIES].filter(
      (name) => !(name in COMMAND_DOCS),
    );
    expect(unmapped).toEqual([]);
  });

  test("COMMAND_DOCS has no stale entries (all still in index.ts)", () => {
    const stale = Object.keys(COMMAND_DOCS).filter(
      (name) => !FOUND_FACTORIES.has(name),
    );
    expect(stale).toEqual([]);
  });

  test("every mapped command has a docs/cli/<slug>.md file", () => {
    const missing = Object.values(COMMAND_DOCS)
      .filter((slug): slug is string => slug !== null)
      .filter((slug) => !existsSync(join(DOCS_CLI, `${slug}.md`)));
    expect(missing).toEqual([]);
  });

  test("every docs/cli/*.md file maps to a command or the allowlist", () => {
    const documented = new Set(
      Object.values(COMMAND_DOCS).filter((s): s is string => s !== null),
    );
    const docFiles = readdirSync(DOCS_CLI)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    const orphans = docFiles.filter(
      (name) => !documented.has(name) && !NON_COMMAND_DOCS.has(name),
    );
    expect(orphans).toEqual([]);
  });
});
