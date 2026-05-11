/**
 * Wikipedia dump import helpers.
 *
 * Wikimedia's public database dumps for article text are MediaWiki XML export
 * files, most commonly distributed as bzip2 archives named like:
 *
 *   enwiki-latest-pages-articles-multistream.xml.bz2
 *
 * The "multistream" suffix means the .bz2 file is composed of multiple bzip2
 * streams plus a companion index file. For a sequential import we can treat it
 * as a normal bzip2-compressed XML file and stream-decompress it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { normalizeSlug } from "./importers/slug.ts";

export const DEFAULT_WIKIPEDIA_WIKI = "simplewiki";
export const DEFAULT_WIKIPEDIA_DUMP_DATE = "latest";
export const DEFAULT_WIKIPEDIA_DUMP_KIND = "pages-articles-multistream";
export const WIKIPEDIA_DUMP_FORMAT =
  "MediaWiki XML export (usually bzip2-compressed .xml.bz2)";
export const WIKIPEDIA_IMPORTER_VERSION = "1";

const WIKIPEDIA_LAUNCH_TIMESTAMP_MS = Date.UTC(2001, 0, 15);

export type WikipediaContentMode = "plain" | "wikitext";

export interface WikipediaPage {
  title: string;
  namespace: number;
  pageId: string;
  revisionId: string;
  timestamp?: string;
  text: string;
  redirectTitle?: string;
  model?: string;
  format?: string;
  sha1?: string;
  textBytes?: number;
}

export interface WikipediaMemoryBuildOptions {
  wikiSlug: string;
  treeRoot: string;
  contentMode: WikipediaContentMode;
  sourceDumpPath?: string;
  sourceDumpUrl?: string;
  sourceDumpDate?: string;
  sourceDumpKind?: string;
  importedAt: string;
  maxContentBytes?: number;
}

export interface BuiltWikipediaMemory {
  memory: MemoryCreateParams;
  categories: string[];
  truncated: boolean;
  contentBytes: number;
  articleSlug: string;
}

export interface DownloadFileResult {
  path: string;
  downloaded: boolean;
  bytesDownloaded: number;
  totalBytes?: number;
}

export interface DownloadFileOptions {
  force?: boolean;
  onProgress?: (progress: {
    bytesDownloaded: number;
    totalBytes?: number;
  }) => void | Promise<void>;
}

export interface OpenedDumpTextStream {
  stream: ReadableStream<Uint8Array>;
  completion: Promise<void>;
  close: () => void;
}

/** Build the canonical Wikimedia dump URL for a wiki database name. */
export function buildWikipediaDumpUrl(
  wikiSlug: string,
  dumpDate = DEFAULT_WIKIPEDIA_DUMP_DATE,
  dumpKind = DEFAULT_WIKIPEDIA_DUMP_KIND,
): string {
  return `https://dumps.wikimedia.org/${wikiSlug}/${dumpDate}/${wikiSlug}-${dumpDate}-${dumpKind}.xml.bz2`;
}

/** Infer `enwiki` / `simplewiki` from a standard Wikimedia dump filename. */
export function inferWikiSlugFromDumpName(
  fileName: string,
): string | undefined {
  const match = /^([a-z0-9_]+)-(?:latest|\d{8})-[^.]+/i.exec(fileName);
  return match?.[1]?.toLowerCase();
}

/** Infer `latest` / `20260501` from a standard Wikimedia dump filename. */
export function inferDumpDateFromDumpName(
  fileName: string,
): string | undefined {
  const match = /^[a-z0-9_]+-((?:latest|\d{8}))-[^.]+/i.exec(fileName);
  return match?.[1]?.toLowerCase();
}

/** Infer `pages-articles-multistream` from a standard dump filename. */
export function inferDumpKindFromDumpName(
  fileName: string,
): string | undefined {
  const match = /^[a-z0-9_]+-(?:latest|\d{8})-(.+?)\.xml(?:\.bz2)?$/i.exec(
    fileName,
  );
  return match?.[1]?.toLowerCase();
}

/** Download a URL to disk using a streaming response body. */
export async function downloadFile(
  url: string,
  destinationPath: string,
  options: DownloadFileOptions = {},
): Promise<DownloadFileResult> {
  if (existsSync(destinationPath) && !options.force) {
    const size = await Bun.file(destinationPath).size;
    return {
      path: destinationPath,
      downloaded: false,
      bytesDownloaded: size,
      totalBytes: size,
    };
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.part`;
  try {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  } catch {
    // Best effort cleanup; createWriteStream will surface a real error below.
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`Failed to download ${url}: empty response body`);
  }

  const totalHeader = response.headers.get("content-length");
  const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : undefined;
  const output = createWriteStream(temporaryPath);
  const reader = response.body.getReader();
  let bytesDownloaded = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesDownloaded += value.byteLength;
      if (!output.write(Buffer.from(value))) {
        await once(output, "drain");
      }
      await options.onProgress?.({ bytesDownloaded, totalBytes });
    }
  } catch (error) {
    output.destroy();
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }

  output.end();
  await once(output, "finish");
  renameSync(temporaryPath, destinationPath);

  return {
    path: destinationPath,
    downloaded: true,
    bytesDownloaded,
    totalBytes,
  };
}

/**
 * Open an XML or XML.bz2 dump as a UTF-8 byte stream.
 *
 * Bun/Node do not ship a native bzip2 decoder, so compressed Wikimedia dumps
 * are decompressed by invoking an installed bzip2-compatible CLI. We prefer
 * parallel implementations when present, then fall back to the ubiquitous
 * `bzip2 -dc`.
 */
export function openDumpTextStream(dumpPath: string): OpenedDumpTextStream {
  if (!dumpPath.toLowerCase().endsWith(".bz2")) {
    return {
      stream: Bun.file(dumpPath).stream() as ReadableStream<Uint8Array>,
      completion: Promise.resolve(),
      close: () => {},
    };
  }

  const decompressor = findBzip2Decompressor();
  if (!decompressor) {
    throw new Error(
      "No bzip2 decompressor found. Install bzip2, lbzip2, pbzip2, or bzcat to read Wikipedia .xml.bz2 dumps.",
    );
  }

  const args = decompressor === "bzcat" ? [dumpPath] : ["-dc", dumpPath];
  const child = spawn(decompressor, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.stdout) {
    throw new Error(`Failed to open ${decompressor} stdout`);
  }

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });

  let closeRequested = false;
  const completion = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      const stoppedByConsumer =
        closeRequested || signal === "SIGTERM" || /broken pipe/i.test(stderr);
      if (code === 0 || stoppedByConsumer) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${decompressor} exited ${signal ? `with signal ${signal}` : `with code ${code}`}${detail}`,
        ),
      );
    });
  });

  return {
    stream: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    completion,
    close: () => {
      closeRequested = true;
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

function findBzip2Decompressor(): string | undefined {
  for (const command of ["lbzip2", "pbzip2", "bzip2", "bzcat"]) {
    if (Bun.which(command)) return command;
  }
  return undefined;
}

/** Stream MediaWiki pages from a decompressed dump without loading the file. */
export async function* streamMediaWikiPages(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<WikipediaPage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      yield* drainCompletePagesFromBuffer(
        () => buffer,
        (next) => {
          buffer = next;
        },
      );
    }

    yield* drainCompletePagesFromBuffer(
      () => buffer,
      (next) => {
        buffer = next;
      },
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function* drainCompletePagesFromBuffer(
  getBuffer: () => string,
  setBuffer: (next: string) => void,
): Generator<WikipediaPage> {
  let buffer = getBuffer();
  while (true) {
    const start = buffer.indexOf("<page>");
    if (start === -1) {
      // Keep only a small suffix in case '<page>' is split across chunks.
      setBuffer(buffer.slice(-16));
      return;
    }
    if (start > 0) buffer = buffer.slice(start);

    const end = buffer.indexOf("</page>");
    if (end === -1) {
      setBuffer(buffer);
      return;
    }

    const pageXml = buffer.slice(0, end + "</page>".length);
    buffer = buffer.slice(end + "</page>".length);
    const page = parseMediaWikiPageXml(pageXml);
    if (page) yield page;
  }
}

/** Parse one <page>...</page> block from a MediaWiki XML export. */
export function parseMediaWikiPageXml(pageXml: string): WikipediaPage | null {
  const revisionStart = pageXml.indexOf("<revision>");
  const pageHeaderXml =
    revisionStart === -1 ? pageXml : pageXml.slice(0, revisionStart);
  const revisionXml = revisionStart === -1 ? "" : pageXml.slice(revisionStart);

  const title = extractXmlTagText(pageHeaderXml, "title");
  const namespaceText = extractXmlTagText(pageHeaderXml, "ns");
  const pageId = extractXmlTagText(pageHeaderXml, "id");
  const revisionId = extractXmlTagText(revisionXml, "id") ?? "";
  if (!title || !namespaceText || !pageId) return null;

  const namespace = Number.parseInt(namespaceText, 10);
  if (Number.isNaN(namespace)) return null;

  const redirectMatch = /<redirect\b([^>]*)\/?\s*>/i.exec(pageHeaderXml);
  const redirectTitle = redirectMatch
    ? extractXmlAttribute(redirectMatch[1] ?? "", "title")
    : undefined;

  const textMatch = /<text\b([^>]*)>([\s\S]*?)<\/text>/i.exec(revisionXml);
  const selfClosingTextMatch = /<text\b([^>]*)\/\s*>/i.exec(revisionXml);
  const textAttributes = textMatch?.[1] ?? selfClosingTextMatch?.[1] ?? "";
  const text = textMatch ? decodeXmlEntities(textMatch[2] ?? "") : "";
  const textBytesRaw = extractXmlAttribute(textAttributes, "bytes");
  const textBytes = textBytesRaw
    ? Number.parseInt(textBytesRaw, 10)
    : undefined;

  return {
    title,
    namespace,
    pageId,
    revisionId,
    timestamp: extractXmlTagText(revisionXml, "timestamp") ?? undefined,
    text,
    redirectTitle,
    model: extractXmlTagText(revisionXml, "model") ?? undefined,
    format: extractXmlTagText(revisionXml, "format") ?? undefined,
    sha1: extractXmlTagText(revisionXml, "sha1") ?? undefined,
    textBytes: Number.isFinite(textBytes) ? textBytes : undefined,
  };
}

function extractXmlTagText(xml: string, tagName: string): string | null {
  const match = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i",
  ).exec(xml);
  return match ? decodeXmlEntities(match[1] ?? "") : null;
}

function extractXmlAttribute(
  attributes: string,
  name: string,
): string | undefined {
  const doubleQuoted = new RegExp(`${name}="([^"]*)"`, "i").exec(attributes);
  if (doubleQuoted) return decodeXmlEntities(doubleQuoted[1] ?? "");
  const singleQuoted = new RegExp(`${name}='([^']*)'`, "i").exec(attributes);
  return singleQuoted ? decodeXmlEntities(singleQuoted[1] ?? "") : undefined;
}

/** Decode XML entities plus common HTML entities that survive wikitext cleanup. */
export function decodeXmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
  };

  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/g,
    (entity, body: string) => {
      if (body.startsWith("#x")) {
        const codePoint = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (body.startsWith("#")) {
        const codePoint = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return namedEntities[body.toLowerCase()] ?? entity;
    },
  );
}

/** Extract article categories from raw wikitext before category links are stripped. */
export function extractCategories(wikitext: string): string[] {
  const categories: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[\s*Category\s*:\s*([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gi;
  for (const match of wikitext.matchAll(re)) {
    const category = decodeXmlEntities(match[1] ?? "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const key = category.toLowerCase();
    if (category && !seen.has(key)) {
      seen.add(key);
      categories.push(category);
    }
  }
  return categories;
}

/**
 * Lightweight wikitext-to-plain-text conversion.
 *
 * This intentionally favors speed and predictable memory use over perfect
 * MediaWiki rendering. It removes high-noise constructs (templates, refs,
 * tables, files, categories) and keeps readable article prose plus headings.
 */
export function cleanWikitextToPlainText(wikitext: string): string {
  let text = wikitext;

  text = text.replace(/<!--([\s\S]*?)-->/g, "");
  text = text.replace(/<ref\b[^>]*\/>/gi, "");
  text = text.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "");
  text = text.replace(/<references\b[^>]*\/>/gi, "");
  text = text.replace(/<gallery\b[^>]*>[\s\S]*?<\/gallery>/gi, "");
  text = text.replace(/<timeline\b[^>]*>[\s\S]*?<\/timeline>/gi, "");
  text = text.replace(/<score\b[^>]*>[\s\S]*?<\/score>/gi, "");
  text = text.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, "");

  text = stripWikiTables(text);
  text = stripBalancedTemplates(text);

  // Drop file/image links and category declarations before generic link cleanup.
  // File captions often contain nested links, so this must be balanced instead
  // of a single regex; otherwise captions leak through as `...]]` fragments.
  text = stripWikiLinksByNamespace(text, ["file", "image", "category"]);

  const headingSentinel = "\uE000";
  text = text.replace(
    /^(={2,6})\s*(.*?)\s*\1\s*$/gm,
    (_match, marker: string, heading: string) => {
      const markdownLevel = Math.min(marker.length, 6);
      return `${headingSentinel}${"#".repeat(markdownLevel)} ${heading.trim()}`;
    },
  );

  text = text.replace(/'''([^'].*?)'''/g, "$1");
  text = text.replace(/''([^'].*?)''/g, "$1");

  // External links: keep labels, remove bare URLs.
  text = text.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/gi, "$1");
  text = text.replace(/\[https?:\/\/[^\]]+\]/gi, "");

  // Internal links: [[Target|label]] -> label, [[Target]] -> Target.
  text = text.replace(/\[\[([^[\]\n]+?)\]\]/g, (_match, linkBody: string) => {
    const parts = linkBody.split("|");
    const target = (parts[0] ?? "").trim().replace(/^:/, "");
    if (/^(?:category|file|image):/i.test(target)) return "";
    const label = (parts.length > 1 ? parts[parts.length - 1] : target) ?? "";
    return label.replace(/_/g, " ").replace(/^:/, "").trim();
  });

  text = text.replace(/<br\s*\/?\s*>/gi, "\n");
  text = text.replace(/<\/(?:p|div|section)>/gi, "\n\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeXmlEntities(text);

  // Wikitext list markers to readable plain/markdown-ish markers.
  text = text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith(headingSentinel)) return trimmed.slice(1);
      if (/^\*+\s*/.test(trimmed)) return trimmed.replace(/^\*+\s*/, "- ");
      if (/^#+\s*/.test(trimmed)) return trimmed.replace(/^#+\s*/, "1. ");
      if (/^[;:]+\s*/.test(trimmed)) return trimmed.replace(/^[;:]+\s*/, "");
      return trimmed;
    })
    .join("\n");

  // Remove lingering table row syntax and magic words.
  text = text.replace(/^\s*(?:\|-|[|!])[^\n]*$/gm, "");
  text = text.replace(/__[A-Z_]+__/g, "");

  const cleaned = text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return removeEmptyListItemsAndSections(cleaned);
}

function removeEmptyListItemsAndSections(input: string): string {
  let lines = input.split("\n").filter((line) => !/^\s*[-*]\s*$/.test(line));
  let previousLength = -1;
  while (lines.length !== previousLength) {
    previousLength = lines.length;
    lines = removeEmptySections(lines);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeEmptySections(lines: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const level = markdownSectionHeadingLevel(line);
    if (level === null) {
      output.push(line);
      continue;
    }

    let sectionEnd = index + 1;
    while (sectionEnd < lines.length) {
      const nextLevel = markdownSectionHeadingLevel(lines[sectionEnd] ?? "");
      if (nextLevel !== null && nextLevel <= level) break;
      sectionEnd++;
    }

    const hasSectionContent = lines
      .slice(index + 1, sectionEnd)
      .some(
        (candidateLine) =>
          candidateLine.trim().length > 0 &&
          markdownSectionHeadingLevel(candidateLine) === null,
      );
    if (hasSectionContent) output.push(line);
  }
  return output;
}

function markdownSectionHeadingLevel(line: string): number | null {
  const match = /^(#{2,6})\s+\S/.exec(line.trim());
  return match ? (match[1] ?? "").length : null;
}

function stripWikiTables(input: string): string {
  let previous = input;
  while (true) {
    const next = previous.replace(/\{\|[\s\S]*?\|\}/g, "\n");
    if (next === previous) return next;
    previous = next;
  }
}

function stripWikiLinksByNamespace(
  input: string,
  namespaces: string[],
): string {
  const namespaceSet = new Set(
    namespaces.map((namespace) => namespace.toLowerCase()),
  );
  let output = "";
  let index = 0;

  while (index < input.length) {
    const start = input.indexOf("[[", index);
    if (start === -1) {
      output += input.slice(index);
      break;
    }

    const linkPrefix = /^\[\[\s*:?\s*([A-Za-z]+)\s*:/i.exec(
      input.slice(start, start + 80),
    );
    if (!linkPrefix || !namespaceSet.has((linkPrefix[1] ?? "").toLowerCase())) {
      output += input.slice(index, start + 2);
      index = start + 2;
      continue;
    }

    output += input.slice(index, start);
    let depth = 1;
    let cursor = start + 2;
    while (cursor < input.length && depth > 0) {
      if (input.startsWith("[[", cursor)) {
        depth++;
        cursor += 2;
      } else if (input.startsWith("]]", cursor)) {
        depth--;
        cursor += 2;
      } else {
        cursor++;
      }
    }
    index = cursor;
  }

  return output;
}

function stripBalancedTemplates(input: string): string {
  let output = "";
  let depth = 0;
  for (let index = 0; index < input.length; index++) {
    if (input.startsWith("{{", index)) {
      depth++;
      index++;
      continue;
    }
    if (depth > 0 && input.startsWith("}}", index)) {
      depth--;
      index++;
      continue;
    }
    if (depth === 0) output += input[index] ?? "";
  }
  return output;
}

/** Build a MemoryCreateParams payload for one parsed article page. */
export function buildWikipediaMemory(
  page: WikipediaPage,
  options: WikipediaMemoryBuildOptions,
): BuiltWikipediaMemory | null {
  const categories = extractCategories(page.text);
  const body =
    options.contentMode === "wikitext"
      ? page.text.trim()
      : cleanWikitextToPlainText(page.text);
  if (!body) return null;

  const rawContent = `# ${page.title}\n\n${body}`;
  const truncated = truncateUtf8(rawContent, options.maxContentBytes);
  const content = truncated.text;
  const articleSlug = normalizeSlug(page.title);
  const primaryCategory = categories[0] ?? "Uncategorized";
  const primaryCategorySlug = normalizeSlug(primaryCategory);
  const tree = `${options.treeRoot}.${primaryCategorySlug}`;
  const sourceUrl = buildWikipediaArticleUrl(options.wikiSlug, page.title);
  const temporalStart =
    page.timestamp && !Number.isNaN(Date.parse(page.timestamp))
      ? new Date(Date.parse(page.timestamp)).toISOString()
      : undefined;

  const meta: Record<string, unknown> = {
    type: "wikipedia_article",
    source: "wikipedia",
    source_wiki: options.wikiSlug,
    source_page_id: page.pageId,
    source_revision_id: page.revisionId,
    source_title: page.title,
    source_namespace: page.namespace,
    source_url: sourceUrl,
    source_format: "mediawiki_xml",
    content_format:
      options.contentMode === "wikitext" ? "mediawiki_wikitext" : "plain_text",
    categories,
    primary_category: primaryCategory,
    primary_category_slug: primaryCategorySlug,
    article_slug: articleSlug,
    imported_at: options.importedAt,
    importer_version: WIKIPEDIA_IMPORTER_VERSION,
  };

  if (options.sourceDumpPath) meta.source_dump_path = options.sourceDumpPath;
  if (options.sourceDumpUrl) meta.source_dump_url = options.sourceDumpUrl;
  if (options.sourceDumpDate) meta.source_dump_date = options.sourceDumpDate;
  if (options.sourceDumpKind) meta.source_dump_kind = options.sourceDumpKind;
  if (page.timestamp) meta.source_revision_timestamp = page.timestamp;
  if (page.redirectTitle) meta.source_redirect_title = page.redirectTitle;
  if (page.model) meta.source_model = page.model;
  if (page.format) meta.source_text_format = page.format;
  if (page.sha1) meta.source_revision_sha1 = page.sha1;
  if (page.textBytes !== undefined) meta.source_text_bytes = page.textBytes;
  if (truncated.truncated) meta.content_truncated = true;
  if (options.maxContentBytes !== undefined) {
    meta.max_content_bytes = options.maxContentBytes;
  }

  return {
    memory: {
      id: deterministicWikipediaPageUuidV7(options.wikiSlug, page.pageId),
      content,
      tree,
      meta,
      ...(temporalStart ? { temporal: { start: temporalStart } } : {}),
    },
    categories,
    truncated: truncated.truncated,
    contentBytes: Buffer.byteLength(content, "utf8"),
    articleSlug,
  };
}

export function buildWikipediaArticleUrl(
  wikiSlug: string,
  title: string,
): string {
  const host = wikipediaHostFromWikiSlug(wikiSlug);
  const encodedTitle = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://${host}/wiki/${encodedTitle}`;
}

export function wikipediaHostFromWikiSlug(wikiSlug: string): string {
  const project = wikiSlug.endsWith("wiki") ? wikiSlug.slice(0, -4) : wikiSlug;
  return `${project}.wikipedia.org`;
}

function truncateUtf8(
  input: string,
  maxBytes: number | undefined,
): { text: string; truncated: boolean } {
  if (maxBytes === undefined || maxBytes <= 0) {
    return { text: input, truncated: false };
  }
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return { text: input, truncated: false };
  }

  const suffix = "\n\n[Article truncated during Wikipedia import.]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(input.slice(0, mid), "utf8") <= contentBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return {
    text: `${input.slice(0, low).trimEnd()}${suffix}`,
    truncated: true,
  };
}

/**
 * Stable UUIDv7 per Wikipedia page id.
 *
 * The id intentionally keys on page id rather than revision id so repeated
 * imports of newer dumps do not create duplicate memories for the same article.
 * The current revision id remains available in metadata.
 */
export function deterministicWikipediaPageUuidV7(
  wikiSlug: string,
  pageId: string,
): string {
  const bytes = new Uint8Array(16);
  const timestampMs = WIKIPEDIA_LAUNCH_TIMESTAMP_MS;
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;

  const digest = createHash("sha256")
    .update(`wikipedia:${wikiSlug}:${pageId}`, "utf8")
    .digest();
  const randA = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0);
  bytes[6] = 0x70 | ((randA >> 8) & 0x0f);
  bytes[7] = randA & 0xff;
  bytes[8] = 0x80 | ((digest[2] ?? 0) & 0x3f);
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = digest[3 + i] ?? 0;
  }

  return bytesToUuid(bytes);
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  }
  return (
    `${hex.slice(0, 4).join("")}-` +
    `${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-` +
    `${hex.slice(8, 10).join("")}-` +
    `${hex.slice(10, 16).join("")}`
  );
}
