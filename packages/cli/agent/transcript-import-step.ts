/**
 * Per-harness transcript-import `init` step — one instance per importer
 * (claude/codex/opencode), shown only when this project actually has
 * sessions for that harness. Replaces a single hardcoded step with a
 * dynamic one per detected harness, so `me project init` doesn't assume
 * Claude is the harness in use.
 */

import { runAgentImport } from "../commands/import.ts";
import type { Importer } from "../importers/index.ts";
import type { SourceTool } from "../importers/types.ts";
import type { InitStep } from "./init.ts";

/**
 * Whether `importer` has found ANY session for `projectRoot` — a cheap,
 * read-only probe (no network, no writes) that stops at the first match
 * instead of walking every source file.
 */
export async function projectHasSessions(
  importer: Importer,
  projectRoot: string,
): Promise<boolean> {
  const stats = { totalFiles: 0, yielded: 0, skipped: {}, errors: [] };
  const sessions = importer.discoverSessions(
    {
      projectFilter: projectRoot,
      includeTempCwd: true,
      includeSidechains: false,
      includeTrivial: true,
      fullTranscript: false,
    },
    stats,
  );
  for await (const _session of sessions) return true;
  return false;
}

/** Build the transcript-import step for one harness's importer. */
export function transcriptImportStep(
  tool: SourceTool,
  importer: Importer,
  toolLabel: string,
): InitStep {
  return {
    id: `transcript-import-${tool}`,
    group: `${toolLabel} sessions`,
    kind: "backfill",
    optionKey: `skipTranscriptImport${tool[0]?.toUpperCase()}${tool.slice(1)}`,
    skipFlag: `--skip-transcript-import-${tool}`,
    skipDescription: `do not import this project's ${toolLabel} sessions`,
    label: `Import this project's existing ${toolLabel} sessions (one-time backfill)`,
    // Hidden when this project has no sessions for this harness at all —
    // no point offering a backfill with nothing to backfill.
    available: async ({ projectRoot }) =>
      (await projectHasSessions(importer, projectRoot ?? process.cwd()))
        ? "available"
        : "hidden",
    run: async ({ globalOpts, projectRoot }) => {
      await runAgentImport(
        importer,
        { project: projectRoot ?? process.cwd(), includeTempCwd: true },
        globalOpts,
      );
    },
  };
}
