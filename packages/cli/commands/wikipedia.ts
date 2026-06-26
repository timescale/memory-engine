/**
 * me import wikipedia — import Wikimedia article dumps as memories.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { Command } from "commander";
import { batchCreateChunked } from "../chunk.ts";
import type { MemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, type OutputFormat, output } from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  requireMemoryAuth,
  requireSpace,
} from "../util.ts";
import {
  buildWikipediaDumpUrl,
  buildWikipediaMemory,
  DEFAULT_WIKIPEDIA_DUMP_DATE,
  DEFAULT_WIKIPEDIA_DUMP_KIND,
  DEFAULT_WIKIPEDIA_WIKI,
  downloadFile,
  inferDumpDateFromDumpName,
  inferDumpKindFromDumpName,
  inferWikiSlugFromDumpName,
  openDumpTextStream,
  streamMediaWikiPages,
  WIKIPEDIA_DUMP_FORMAT,
  type WikipediaContentMode,
} from "../wikipedia.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";

const DEFAULT_TREE_ROOT = "share.wikipedia";
const DEFAULT_BATCH_SIZE = 500;
const OPENAI_TEXT_EMBEDDING_3_SMALL_USD_PER_MILLION_TOKENS = 0.02;
const VALID_WIKI_SLUG_RE = /^[a-z0-9_]+wiki$/i;

interface ResolvedWikipediaSource {
  wikiSlug: string;
  dumpDate?: string;
  dumpKind?: string;
  sourceUrl?: string;
  sourcePath: string;
  downloaded: boolean;
  bytesDownloaded?: number;
  totalBytes?: number;
}

interface WikipediaImportStats {
  dryRun: boolean;
  dumpFormat: string;
  sourcePath: string;
  sourceUrl?: string;
  wikiSlug: string;
  dumpDate?: string;
  dumpKind?: string;
  treeRoot: string;
  namespace: number;
  includeRedirects: boolean;
  contentMode: WikipediaContentMode;
  pagesScanned: number;
  namespaceSkipped: number;
  redirectsSkipped: number;
  emptyContentSkipped: number;
  memoriesPrepared: number;
  contentTruncated: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  estimatedContentBytes: number;
  estimatedEmbeddingTokens: number;
  estimatedEmbeddingCostUsd: number;
  errors: Array<{ source: string; error: string; itemCount?: number }>;
}

export function createWikipediaImportCommand(name = "wikipedia"): Command {
  return new Command(name)
    .description("download and import a Wikipedia XML dump as memories")
    .argument(
      "[source]",
      "wiki slug (simplewiki/enwiki), dump URL, or local .xml/.xml.bz2 file",
    )
    .option(
      "--wiki <wiki>",
      "wiki database name when source is omitted or a local file",
      DEFAULT_WIKIPEDIA_WIKI,
    )
    .option(
      "--date <date>",
      "dump date for Wikimedia URLs",
      DEFAULT_WIKIPEDIA_DUMP_DATE,
    )
    .option(
      "--dump-kind <kind>",
      "Wikimedia dump kind",
      DEFAULT_WIKIPEDIA_DUMP_KIND,
    )
    .option(
      "--cache-dir <dir>",
      "directory for downloaded dump archives",
      defaultWikipediaCacheDir(),
    )
    .option("--force-download", "redownload even when the cache file exists")
    .option("--download-only", "download the dump archive and exit")
    .option(
      "--tree-root <path>",
      "tree root for imported memories",
      DEFAULT_TREE_ROOT,
    )
    .option(
      "--namespace <n>",
      "MediaWiki namespace number to import (0 = articles)",
      "0",
    )
    .option("--include-redirects", "import redirect pages (default: skip)")
    .option(
      "--content-mode <mode>",
      "article content to store: plain or wikitext",
      "plain",
    )
    .option(
      "--max-content-bytes <n>",
      "truncate each memory content to this many UTF-8 bytes (0 disables truncation)",
    )
    .option("--limit <n>", "maximum article memories to process after filters")
    .option(
      "--batch-size <n>",
      "memories to buffer before each batchCreate",
      String(DEFAULT_BATCH_SIZE),
    )
    .option("--dry-run", "parse and estimate without writing memories")
    .option(
      "--update-existing",
      "update existing deterministic Wikipedia memories instead of skipping them",
    )
    .option("-v, --verbose", "show per-batch progress output")
    .action(async (source: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const fmt = getOutputFormat(globalOpts);
      const requiresEngine = opts.dryRun !== true && opts.downloadOnly !== true;

      let engine: MemoryClient | undefined;
      if (requiresEngine) {
        const creds = resolveCredentials(
          typeof globalOpts.server === "string" ? globalOpts.server : undefined,
        );
        requireMemoryAuth(creds, fmt);
        requireSpace(creds, fmt);
        engine = buildMemoryClient(creds);
      }

      try {
        const resolvedSource = await resolveWikipediaSource(source, opts, fmt);

        if (opts.downloadOnly) {
          await output(
            {
              downloaded: resolvedSource.downloaded,
              path: resolvedSource.sourcePath,
              url: resolvedSource.sourceUrl,
              wikiSlug: resolvedSource.wikiSlug,
              dumpDate: resolvedSource.dumpDate,
              dumpKind: resolvedSource.dumpKind,
              dumpFormat: WIKIPEDIA_DUMP_FORMAT,
              bytesDownloaded: resolvedSource.bytesDownloaded,
              totalBytes: resolvedSource.totalBytes,
            },
            fmt,
            () => {
              const verb = resolvedSource.downloaded
                ? "Downloaded"
                : "Using cached";
              clack.log.success(`${verb} ${resolvedSource.sourcePath}`);
              console.log(`  Format: ${WIKIPEDIA_DUMP_FORMAT}`);
              if (resolvedSource.sourceUrl) {
                console.log(`  URL: ${resolvedSource.sourceUrl}`);
              }
            },
          );
          return;
        }

        const parsedOptions = parseWikipediaImportOptions(opts);
        const result = await runWikipediaImport({
          engine,
          resolvedSource,
          fmt,
          dryRun: opts.dryRun === true,
          verbose: opts.verbose === true,
          treeRoot: parsedOptions.treeRoot,
          namespace: parsedOptions.namespace,
          includeRedirects: opts.includeRedirects === true,
          contentMode: parsedOptions.contentMode,
          maxContentBytes: parsedOptions.maxContentBytes,
          limit: parsedOptions.limit,
          batchSize: parsedOptions.batchSize,
          updateExisting: opts.updateExisting === true,
        });

        await output(result, fmt, () => renderWikipediaImportResult(result));

        if (result.failed > 0 && result.imported === 0 && !result.dryRun) {
          process.exit(2);
        }
        if (result.failed > 0 && !result.dryRun) process.exit(1);
      } catch (error) {
        handleError(error, fmt);
      }
    });
}

interface ParsedWikipediaImportOptions {
  treeRoot: string;
  namespace: number;
  contentMode: WikipediaContentMode;
  maxContentBytes?: number;
  limit?: number;
  batchSize: number;
}

function parseWikipediaImportOptions(
  opts: Record<string, unknown>,
): ParsedWikipediaImportOptions {
  const treeRoot = String(opts.treeRoot ?? DEFAULT_TREE_ROOT);
  if (!VALID_TREE_ROOT_RE.test(treeRoot)) {
    throw new Error(
      `Invalid --tree-root: '${treeRoot}'. Use ltree labels ([A-Za-z0-9_-]) separated by '.' or '/', with an optional leading '~' for your home.`,
    );
  }

  const namespace = parseNonNegativeInteger("--namespace", opts.namespace);
  const contentMode = String(opts.contentMode ?? "plain");
  if (contentMode !== "plain" && contentMode !== "wikitext") {
    throw new Error("Invalid --content-mode: must be plain or wikitext");
  }

  const maxContentBytes =
    opts.maxContentBytes === undefined
      ? undefined
      : parseNonNegativeInteger("--max-content-bytes", opts.maxContentBytes);
  const limit =
    opts.limit === undefined
      ? undefined
      : parsePositiveInteger("--limit", opts.limit);
  const batchSize = parsePositiveInteger("--batch-size", opts.batchSize);

  return {
    treeRoot,
    namespace,
    contentMode,
    maxContentBytes: maxContentBytes === 0 ? undefined : maxContentBytes,
    limit,
    batchSize,
  };
}

async function resolveWikipediaSource(
  source: string | undefined,
  opts: Record<string, unknown>,
  fmt: OutputFormat,
): Promise<ResolvedWikipediaSource> {
  const cacheDir = resolve(expandHome(String(opts.cacheDir)));
  const requestedDumpKind = String(
    opts.dumpKind ?? DEFAULT_WIKIPEDIA_DUMP_KIND,
  );
  const force = opts.forceDownload === true;

  if (source && isUrl(source)) {
    const url = source;
    const fileName = basename(new URL(url).pathname);
    const sourcePath = join(cacheDir, fileName);
    const wikiSlug = normalizeWikiSlug(
      inferWikiSlugFromDumpName(fileName) ??
        String(opts.wiki ?? DEFAULT_WIKIPEDIA_WIKI),
    );
    const dumpDate =
      inferDumpDateFromDumpName(fileName) ??
      String(opts.date ?? DEFAULT_WIKIPEDIA_DUMP_DATE);
    const dumpKind = inferDumpKindFromDumpName(fileName) ?? requestedDumpKind;
    const downloaded = await downloadWikipediaSource(
      url,
      sourcePath,
      force,
      fmt,
    );
    return {
      wikiSlug,
      dumpDate,
      dumpKind,
      sourceUrl: url,
      sourcePath,
      downloaded: downloaded.downloaded,
      bytesDownloaded: downloaded.bytesDownloaded,
      totalBytes: downloaded.totalBytes,
    };
  }

  if (source && existsSync(resolve(expandHome(source)))) {
    const sourcePath = resolve(expandHome(source));
    const fileName = basename(sourcePath);
    return {
      wikiSlug: normalizeWikiSlug(
        inferWikiSlugFromDumpName(fileName) ??
          String(opts.wiki ?? DEFAULT_WIKIPEDIA_WIKI),
      ),
      dumpDate:
        inferDumpDateFromDumpName(fileName) ??
        String(opts.date ?? DEFAULT_WIKIPEDIA_DUMP_DATE),
      dumpKind: inferDumpKindFromDumpName(fileName) ?? requestedDumpKind,
      sourcePath,
      downloaded: false,
    };
  }

  const sourceLooksLikeWikiSlug = source && VALID_WIKI_SLUG_RE.test(source);
  if (source && !sourceLooksLikeWikiSlug) {
    throw new Error(
      `Source '${source}' is not a URL, an existing file, or a wiki slug like enwiki/simplewiki.`,
    );
  }

  const wikiSlug = normalizeWikiSlug(
    String(source ?? opts.wiki ?? DEFAULT_WIKIPEDIA_WIKI),
  );

  const dumpDate = String(opts.date ?? DEFAULT_WIKIPEDIA_DUMP_DATE);
  const url = buildWikipediaDumpUrl(wikiSlug, dumpDate, requestedDumpKind);
  const fileName = basename(new URL(url).pathname);
  const sourcePath = join(cacheDir, fileName);
  const downloaded = await downloadWikipediaSource(url, sourcePath, force, fmt);

  return {
    wikiSlug,
    dumpDate,
    dumpKind: requestedDumpKind,
    sourceUrl: url,
    sourcePath,
    downloaded: downloaded.downloaded,
    bytesDownloaded: downloaded.bytesDownloaded,
    totalBytes: downloaded.totalBytes,
  };
}

async function downloadWikipediaSource(
  url: string,
  destinationPath: string,
  force: boolean,
  fmt: OutputFormat,
) {
  let lastProgressAt = 0;
  let wroteProgress = false;
  return await downloadFile(url, destinationPath, {
    force,
    onProgress: ({ bytesDownloaded, totalBytes }) => {
      if (fmt !== "text" || !process.stderr.isTTY) return;
      const now = Date.now();
      if (now - lastProgressAt < 1000) return;
      lastProgressAt = now;
      wroteProgress = true;
      const total = totalBytes ? ` / ${formatBytes(totalBytes)}` : "";
      process.stderr.write(
        `\rDownloading ${formatBytes(bytesDownloaded)}${total}...`,
      );
    },
  }).finally(() => {
    if (wroteProgress) process.stderr.write("\n");
  });
}

interface RunWikipediaImportOptions {
  engine?: MemoryClient;
  resolvedSource: ResolvedWikipediaSource;
  fmt: OutputFormat;
  dryRun: boolean;
  verbose: boolean;
  treeRoot: string;
  namespace: number;
  includeRedirects: boolean;
  contentMode: WikipediaContentMode;
  maxContentBytes?: number;
  limit?: number;
  batchSize: number;
  updateExisting: boolean;
}

async function runWikipediaImport(
  options: RunWikipediaImportOptions,
): Promise<WikipediaImportStats> {
  const importedAt = new Date().toISOString();
  const stats: WikipediaImportStats = {
    dryRun: options.dryRun,
    dumpFormat: WIKIPEDIA_DUMP_FORMAT,
    sourcePath: options.resolvedSource.sourcePath,
    sourceUrl: options.resolvedSource.sourceUrl,
    wikiSlug: options.resolvedSource.wikiSlug,
    dumpDate: options.resolvedSource.dumpDate,
    dumpKind: options.resolvedSource.dumpKind,
    treeRoot: options.treeRoot,
    namespace: options.namespace,
    includeRedirects: options.includeRedirects,
    contentMode: options.contentMode,
    pagesScanned: 0,
    namespaceSkipped: 0,
    redirectsSkipped: 0,
    emptyContentSkipped: 0,
    memoriesPrepared: 0,
    contentTruncated: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    estimatedContentBytes: 0,
    estimatedEmbeddingTokens: 0,
    estimatedEmbeddingCostUsd: 0,
    errors: [],
  };

  const pending: MemoryCreateParams[] = [];
  let batchNumber = 0;
  let stoppedEarly = false;
  let lastProgressAt = 0;
  const openedDump = openDumpTextStream(options.resolvedSource.sourcePath);

  const flushPending = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    batchNumber++;

    if (options.dryRun) {
      if (options.verbose && options.fmt === "text") {
        console.error(
          `Validated batch ${batchNumber} (${batch.length} memories)`,
        );
      }
      return;
    }

    if (!options.engine)
      throw new Error("Engine client is required for import");
    const explicitIds = batch
      .map((memory) => memory.id)
      .filter((id): id is string => typeof id === "string");
    const { insertedIds, failedIds, errors } = await batchCreateChunked(
      options.engine,
      batch,
    );
    stats.imported += insertedIds.length;
    const insertedSet = new Set(insertedIds);
    const failedSet = new Set(failedIds);
    const skippedIds = explicitIds.filter(
      (id) => !insertedSet.has(id) && !failedSet.has(id),
    );

    if (options.updateExisting) {
      const payloadsById = new Map(
        batch
          .filter(
            (memory): memory is MemoryCreateParams & { id: string } =>
              typeof memory.id === "string",
          )
          .map((memory) => [memory.id, memory]),
      );
      for (const skippedId of skippedIds) {
        const payload = payloadsById.get(skippedId);
        if (!payload) continue;
        try {
          await options.engine.memory.update({
            id: skippedId,
            content: payload.content,
            meta: payload.meta,
            tree: payload.tree,
            temporal: payload.temporal,
          });
          stats.updated++;
        } catch (error) {
          stats.failed++;
          stats.errors.push({
            source: `batch ${batchNumber}, update ${skippedId}`,
            error: error instanceof Error ? error.message : String(error),
            itemCount: 1,
          });
        }
      }
    } else {
      stats.skipped += skippedIds.length;
    }

    for (const error of errors) {
      stats.failed += error.itemCount;
      stats.errors.push({
        source: `batch ${batchNumber}, chunk ${error.chunkIndex}`,
        error: error.error,
        itemCount: error.itemCount,
      });
    }

    if (options.verbose && options.fmt === "text") {
      console.error(
        `Imported batch ${batchNumber}: +${insertedIds.length}, updated=${stats.updated}, skipped=${stats.skipped}, failed=${stats.failed}`,
      );
    }
  };

  try {
    for await (const page of streamMediaWikiPages(openedDump.stream)) {
      stats.pagesScanned++;

      if (page.namespace !== options.namespace) {
        stats.namespaceSkipped++;
        maybeRenderProgress(options, stats, lastProgressAt, (next) => {
          lastProgressAt = next;
        });
        continue;
      }

      const redirect =
        page.redirectTitle !== undefined ||
        /^#REDIRECT\b/i.test(page.text.trim());
      if (redirect && !options.includeRedirects) {
        stats.redirectsSkipped++;
        maybeRenderProgress(options, stats, lastProgressAt, (next) => {
          lastProgressAt = next;
        });
        continue;
      }

      const built = buildWikipediaMemory(page, {
        wikiSlug: options.resolvedSource.wikiSlug,
        treeRoot: options.treeRoot,
        contentMode: options.contentMode,
        sourceDumpPath: options.resolvedSource.sourcePath,
        sourceDumpUrl: options.resolvedSource.sourceUrl,
        sourceDumpDate: options.resolvedSource.dumpDate,
        sourceDumpKind: options.resolvedSource.dumpKind,
        importedAt,
        maxContentBytes: options.maxContentBytes,
      });

      if (!built) {
        stats.emptyContentSkipped++;
        continue;
      }

      stats.memoriesPrepared++;
      stats.estimatedContentBytes += built.contentBytes;
      if (built.truncated) stats.contentTruncated++;
      pending.push(built.memory);

      if (pending.length >= options.batchSize) {
        await flushPending();
      }

      maybeRenderProgress(options, stats, lastProgressAt, (next) => {
        lastProgressAt = next;
      });

      if (
        options.limit !== undefined &&
        stats.memoriesPrepared >= options.limit
      ) {
        stoppedEarly = true;
        break;
      }
    }

    await flushPending();
  } finally {
    if (stoppedEarly) {
      openedDump.close();
      await openedDump.completion.catch(() => {});
    } else {
      await openedDump.completion;
    }
    if (options.fmt === "text" && process.stderr.isTTY)
      process.stderr.write("\n");
  }

  stats.estimatedEmbeddingTokens = estimateEmbeddingTokens(
    stats.estimatedContentBytes,
  );
  stats.estimatedEmbeddingCostUsd = estimateEmbeddingCostUsd(
    stats.estimatedEmbeddingTokens,
  );

  return stats;
}

function maybeRenderProgress(
  options: RunWikipediaImportOptions,
  stats: WikipediaImportStats,
  lastProgressAt: number,
  setLastProgressAt: (timestamp: number) => void,
): void {
  if (options.fmt !== "text" || !process.stderr.isTTY) return;
  const now = Date.now();
  if (now - lastProgressAt < 2000) return;
  setLastProgressAt(now);
  process.stderr.write(
    `\rScanned ${formatInteger(stats.pagesScanned)} pages; prepared ${formatInteger(
      stats.memoriesPrepared,
    )} article memories; imported ${formatInteger(stats.imported)}...`,
  );
}

function renderWikipediaImportResult(result: WikipediaImportStats): void {
  const preparedOrImported = result.dryRun
    ? result.memoriesPrepared
    : result.imported;
  let summary = `${result.dryRun ? "Would import" : "Imported"} ${formatInteger(preparedOrImported)} Wikipedia article ${preparedOrImported === 1 ? "memory" : "memories"}`;
  if (!result.dryRun && result.imported === 0 && result.updated > 0) {
    summary = `Updated ${formatInteger(result.updated)} existing Wikipedia article ${result.updated === 1 ? "memory" : "memories"}`;
  } else if (!result.dryRun && result.updated > 0) {
    summary = `${summary} and updated ${formatInteger(result.updated)} existing`;
  }
  clack.log.success(summary);
  console.log(`  Wiki: ${result.wikiSlug}`);
  console.log(`  Format: ${result.dumpFormat}`);
  console.log(`  Source: ${result.sourcePath}`);
  console.log(`  Tree root: ${result.treeRoot}`);
  console.log(`  Pages scanned: ${formatInteger(result.pagesScanned)}`);
  console.log(
    `  Article memories prepared: ${formatInteger(result.memoriesPrepared)}`,
  );
  if (result.updated > 0) {
    console.log(`  Updated existing: ${formatInteger(result.updated)}`);
  }
  if (result.skipped > 0) {
    console.log(`  Already existed: ${formatInteger(result.skipped)}`);
  }
  if (result.failed > 0) {
    console.log(`  Failed: ${formatInteger(result.failed)}`);
  }
  if (result.redirectsSkipped > 0 || result.namespaceSkipped > 0) {
    console.log(
      `  Skipped: redirects=${formatInteger(result.redirectsSkipped)}, namespace=${formatInteger(result.namespaceSkipped)}, empty=${formatInteger(result.emptyContentSkipped)}`,
    );
  }
  if (result.contentTruncated > 0) {
    console.log(`  Truncated: ${formatInteger(result.contentTruncated)}`);
  }
  console.log(
    `  Estimated embedded content: ${formatBytes(result.estimatedContentBytes)} ≈ ${formatInteger(result.estimatedEmbeddingTokens)} tokens (~$${result.estimatedEmbeddingCostUsd.toFixed(2)} with text-embedding-3-small)`,
  );
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const error of result.errors.slice(0, 10)) {
      console.log(`    ${error.source}: ${error.error}`);
    }
    if (result.errors.length > 10) {
      console.log(`    ... ${result.errors.length - 10} more`);
    }
  }
}

function defaultWikipediaCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "memory-engine", "wikipedia");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeWikiSlug(value: string): string {
  const wikiSlug = value.toLowerCase();
  if (!VALID_WIKI_SLUG_RE.test(wikiSlug)) {
    throw new Error(
      `Invalid wiki slug '${wikiSlug}'. Use a Wikimedia database name like enwiki or simplewiki.`,
    );
  }
  return wikiSlug;
}

function parseNonNegativeInteger(name: string, value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer`);
  }
  return parsed;
}

function estimateEmbeddingTokens(contentBytes: number): number {
  return Math.ceil(contentBytes / 4);
}

function estimateEmbeddingCostUsd(tokens: number): number {
  return (
    (tokens / 1_000_000) * OPENAI_TEXT_EMBEDDING_3_SMALL_USD_PER_MILLION_TOKENS
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
