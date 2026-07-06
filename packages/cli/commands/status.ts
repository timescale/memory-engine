/**
 * me status — server, active space, and embedding backlog.
 *
 * A quick space health/progress check. Its main job is to surface async
 * embedding progress after a large import (TNT-188): creates write the memory
 * immediately but leave `embedding IS NULL`, and an in-process worker pool
 * generates the vectors out of band. Right after `me import …` the memories are
 * searchable by keyword but not yet semantically, and nothing told the operator
 * how far along the backlog was. This prints the per-space queue depth so a
 * self-hoster can watch it drain.
 */
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  requireAuth,
  requireSpace,
} from "../util.ts";

/** Human-readable "3m ago" style age for the oldest pending row. */
function ageSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function createStatusCommand(): Command {
  return new Command("status")
    .description("show server, active space, and embedding backlog")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);

      try {
        const embedding = await memory.memory.embeddingStatus();
        output(
          {
            server: creds.server,
            activeSpace: creds.activeSpace,
            embedding,
          },
          fmt,
          () => {
            console.log(`  Server: ${creds.server}`);
            console.log(`  Space:  ${creds.activeSpace}`);
            console.log("  Embedding queue:");
            console.log(`    Pending:   ${embedding.pending}`);
            console.log(`    In flight: ${embedding.inFlight}`);
            console.log(`    Waiting:   ${embedding.waiting}`);
            console.log(`    Failed:    ${embedding.failed}`);
            if (embedding.pending === 0) {
              console.log("  All caught up — no embeddings pending.");
            } else if (embedding.oldestPendingAt) {
              console.log(
                `  Oldest pending queued ${ageSince(embedding.oldestPendingAt)}.`,
              );
            }
          },
        );
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}
