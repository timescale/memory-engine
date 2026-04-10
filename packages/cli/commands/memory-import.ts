/**
 * Memory import — import memories from files or stdin.
 *
 * Supports Markdown (YAML frontmatter), YAML, JSON, and NDJSON.
 * Auto-detects format from file extension or content sniffing.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import { createClient } from "@memory-engine/client";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  type ImportFormat,
  type ParsedMemory,
  parseContent,
} from "../parsers/index.ts";
import { requireEngine, requireSession } from "../util.ts";

/**
 * Collect files from a path. If directory, requires --recursive.
 */
async function collectFiles(
  path: string,
  recursive: boolean,
): Promise<string[]> {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${path}`);
  }

  const stat = statSync(resolved);
  if (stat.isFile()) {
    return [resolved];
  }

  if (stat.isDirectory()) {
    if (!recursive) {
      throw new Error(
        `'${path}' is a directory. Use --recursive to import directories.`,
      );
    }
    const glob = new Bun.Glob("**/*.{md,markdown,yaml,yml,json,ndjson,jsonl}");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: resolved, absolute: true })) {
      files.push(file);
    }
    files.sort();
    return files;
  }

  throw new Error(`Not a file or directory: ${path}`);
}

/**
 * Read stdin as text.
 */
async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

interface ImportResult {
  imported: number;
  failed: number;
  ids: string[];
  errors: Array<{ source: string; error: string }>;
}

export function createMemoryImportCommand(): Command {
  return new Command("import")
    .description("import memories from files or stdin")
    .argument("[files...]", "files to import (use - for stdin)")
    .option("--format <format>", "override format detection (md|yaml|json)")
    .option("-r, --recursive", "recursively import from directories")
    .option("--fail-fast", "stop on first error")
    .option("--dry-run", "validate without importing")
    .option("-v, --verbose", "per-file status output")
    .action(async (files: string[], opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireEngine(creds, fmt);

      // Validate format option
      if (opts.format && !["md", "yaml", "json"].includes(opts.format)) {
        if (fmt === "text") {
          clack.log.error(
            `Invalid format: ${opts.format}. Must be md, yaml, or json.`,
          );
        } else {
          output({ error: `Invalid format: ${opts.format}` }, fmt, () => {});
        }
        process.exit(2);
      }

      const format = opts.format as ImportFormat | undefined;

      // Collect inputs
      const inputs: Array<{ source: string; content: string }> = [];

      if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
        if (opts.verbose && fmt === "text") {
          console.error("Reading from stdin...");
        }
        const content = await readStdin();
        if (!content.trim()) {
          if (fmt === "text") {
            clack.log.error("No input provided");
          } else {
            output({ error: "No input provided" }, fmt, () => {});
          }
          process.exit(2);
        }
        inputs.push({ source: "stdin", content });
      } else {
        for (const file of files) {
          if (file === "-") {
            const content = await readStdin();
            inputs.push({ source: "stdin", content });
          } else {
            try {
              const collected = await collectFiles(
                file,
                opts.recursive ?? false,
              );
              for (const filePath of collected) {
                const content = await readFile(filePath, "utf-8");
                inputs.push({ source: filePath, content });
              }
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              if (opts.failFast) {
                if (fmt === "text") {
                  clack.log.error(msg);
                } else {
                  output({ error: msg }, fmt, () => {});
                }
                process.exit(2);
              }
              // Record error, continue
              inputs.push({ source: file, content: "" });
            }
          }
        }
      }

      // Parse all inputs
      const result: ImportResult = {
        imported: 0,
        failed: 0,
        ids: [],
        errors: [],
      };

      const allMemories: Array<{ source: string; memory: ParsedMemory }> = [];

      for (const input of inputs) {
        if (!input.content && input.source !== "stdin") {
          result.errors.push({
            source: input.source,
            error: "Failed to read file",
          });
          result.failed++;
          if (opts.failFast) break;
          continue;
        }

        try {
          const memories = parseContent(input.content, {
            format,
            filename: input.source !== "stdin" ? input.source : undefined,
          });
          for (const memory of memories) {
            allMemories.push({ source: input.source, memory });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push({ source: input.source, error: msg });
          if (opts.failFast) break;
        }
      }

      // Dry run — report what would happen
      if (opts.dryRun) {
        const wouldImport = allMemories.length;
        const wouldFail = result.errors.length;

        const data = {
          dryRun: true,
          wouldImport,
          wouldFail,
          errors: result.errors,
        };

        output(data, fmt, () => {
          if (opts.verbose) {
            const bySource = new Map<string, number>();
            for (const { source } of allMemories) {
              bySource.set(source, (bySource.get(source) || 0) + 1);
            }
            for (const [source, count] of bySource) {
              console.log(
                `  ✓ ${source} (${count} ${count === 1 ? "memory" : "memories"})`,
              );
            }
            for (const { source, error } of result.errors) {
              console.log(`  ✗ ${source}: ${error}`);
            }
            console.log();
          }
          console.log(
            `Would import ${wouldImport} ${wouldImport === 1 ? "memory" : "memories"}`,
          );
          if (wouldFail > 0) {
            console.log(`Would fail: ${wouldFail}`);
          }
        });

        process.exit(wouldFail > 0 ? 1 : 0);
      }

      // No memories to import
      if (allMemories.length === 0) {
        output(
          {
            imported: 0,
            failed: result.errors.length,
            ids: [],
            errors: result.errors,
          },
          fmt,
          () => {
            clack.log.error("No valid memories to import");
            for (const { error } of result.errors) {
              console.error(`  ${error}`);
            }
          },
        );
        process.exit(result.errors.length > 0 ? 2 : 0);
      }

      // Actual import
      const engine = createClient({ url: creds.server, apiKey: creds.apiKey });

      try {
        const createParams = allMemories.map(({ memory: mem }) => ({
          content: mem.content,
          ...(mem.id ? { id: mem.id } : {}),
          ...(mem.meta ? { meta: mem.meta } : {}),
          ...(mem.tree ? { tree: mem.tree } : {}),
          ...(mem.temporal ? { temporal: mem.temporal } : {}),
        }));

        const response = await engine.memory.batchCreate({
          memories: createParams,
        });

        result.imported = response.ids.length;
        result.ids = response.ids;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push({ source: "server", error: msg });
        result.failed = allMemories.length;
      }

      // Output results
      output(
        {
          imported: result.imported,
          failed: result.failed + result.errors.length,
          ids: result.ids,
          errors: result.errors,
        },
        fmt,
        () => {
          if (opts.verbose) {
            const bySource = new Map<string, number>();
            for (const { source } of allMemories) {
              bySource.set(source, (bySource.get(source) || 0) + 1);
            }
            for (const [source, count] of bySource) {
              console.log(
                `  ✓ ${source} (${count} ${count === 1 ? "memory" : "memories"})`,
              );
            }
            for (const { source, error } of result.errors) {
              console.log(`  ✗ ${source}: ${error}`);
            }
            console.log();
          }
          if (result.errors.length > 0) {
            for (const { error } of result.errors) {
              console.error(error);
            }
          }
          console.log(
            `Imported ${result.imported} ${result.imported === 1 ? "memory" : "memories"}`,
          );
        },
      );

      // Exit code
      const totalFailed = result.failed + result.errors.length;
      if (totalFailed > 0 && result.imported === 0) {
        process.exit(2);
      } else if (totalFailed > 0) {
        process.exit(1);
      }
    });
}
