/**
 * Integrity tests for the docs-site URLs embedded in MCP tool definitions.
 *
 * Validates three properties of `server.ts`:
 *
 *  1. Every `server.registerTool("foo", …)` call has a corresponding
 *     `docs/mcp/foo.md` file. Catches: a new tool added without docs.
 *  2. Every `docs/mcp/*.md` file is referenced by a `registerTool` call.
 *     Catches: orphaned docs (tool removed/renamed but doc lingered).
 *  3. Every `docs.memory.build/<path>.md` URL anywhere in `server.ts`
 *     uses `https://` (not `http://`) and resolves to an existing file
 *     under `docs/`. Catches: typos, scheme regressions, and dangling
 *     pointers like a `Tool docs:` banner aimed at a non-existent page.
 *
 * URLs in `server.ts` are template literals built from `DOCS_BASE` and
 * the `docUrl()` helper, so we import those symbols and resolve every
 * `${DOCS_BASE}/...md` pattern and `docUrl("name")` call back into a
 * concrete URL before validating.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOCS_BASE, docUrl } from "./server.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SERVER_PATH = join(REPO_ROOT, "packages", "cli", "mcp", "server.ts");
const DOCS_ROOT = join(REPO_ROOT, "docs");
const DOCS_MCP = join(DOCS_ROOT, "mcp");

const SOURCE = readFileSync(SERVER_PATH, "utf8");

/** Tool names extracted from `server.registerTool("foo", …)` calls. */
const REGISTERED_TOOLS: string[] = [
  ...SOURCE.matchAll(/registerTool\(\s*"([a-z_][a-z0-9_]*)"/gi),
].map(
  // biome-ignore lint/style/noNonNullAssertion: regex group always present
  (m) => m[1]!,
);

/**
 * Every concrete docs URL the agent sees, resolved from the source.
 *
 * Three patterns:
 *   - `docUrl("name")`            -> docUrl(name)
 *   - `${DOCS_BASE}/path.md`      -> `${DOCS_BASE}/path.md`
 *   - bare `http(s)://docs.memory.build/...md`  -> as-is (literal URLs,
 *     not currently used but caught defensively for future code)
 */
function collectDocUrls(source: string): string[] {
  const urls: string[] = [];

  for (const m of source.matchAll(/docUrl\(\s*"([^"]+)"\s*\)/g)) {
    // biome-ignore lint/style/noNonNullAssertion: regex group always present
    urls.push(docUrl(m[1]!));
  }

  for (const m of source.matchAll(/\$\{DOCS_BASE\}(\/[^\s"`'<>)${]+\.md)/g)) {
    // biome-ignore lint/style/noNonNullAssertion: regex group always present
    urls.push(`${DOCS_BASE}${m[1]!}`);
  }

  for (const m of source.matchAll(
    /https?:\/\/docs\.memory\.build\/[^\s"`'<>)${]+\.md/g,
  )) {
    urls.push(m[0]);
  }

  return urls;
}

const DOC_URLS = collectDocUrls(SOURCE);

describe("MCP doc-link integrity", () => {
  test("at least one tool is registered (regex sanity)", () => {
    expect(REGISTERED_TOOLS.length).toBeGreaterThan(0);
  });

  test("at least one docs.memory.build URL is present (regex sanity)", () => {
    expect(DOC_URLS.length).toBeGreaterThan(0);
  });

  test("every registered tool has a docs/mcp/<tool>.md file", () => {
    const missing = REGISTERED_TOOLS.filter(
      (tool) => !existsSync(join(DOCS_MCP, `${tool}.md`)),
    );
    expect(missing).toEqual([]);
  });

  test("every docs/mcp/*.md file is referenced by a registered tool", () => {
    const docFiles = readdirSync(DOCS_MCP)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    const registered = new Set(REGISTERED_TOOLS);
    const orphans = docFiles.filter((name) => !registered.has(name));
    expect(orphans).toEqual([]);
  });

  test("every docs.memory.build URL uses https://", () => {
    const httpUrls = DOC_URLS.filter((u) => u.startsWith("http://"));
    expect(httpUrls).toEqual([]);
  });

  test("every docs.memory.build URL resolves to an existing file", () => {
    // URL `https://docs.memory.build/foo/bar.md` -> file `docs/foo/bar.md`.
    const broken: { url: string; expected: string }[] = [];
    for (const url of DOC_URLS) {
      const path = url.replace(/^https?:\/\/docs\.memory\.build/, "");
      const expected = join(DOCS_ROOT, path);
      if (!existsSync(expected)) broken.push({ url, expected });
    }
    expect(broken).toEqual([]);
  });
});
