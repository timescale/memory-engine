/**
 * Render a Granola meeting into memory content + metadata.
 *
 * One meeting becomes one memory. The content is a Markdown document with a
 * title heading, a metadata line (date, attendees), the AI summary notes, and
 * — when requested — the full transcript. Keeping it one self-contained
 * Markdown blob (rather than fanning out per-segment memories like the agent
 * importers) matches how a human reads a meeting note and keeps the memory
 * searchable as a unit.
 *
 * Notes are sourced, in order of preference, from: the document's
 * `notes_markdown`, an AI summary panel's `original_content` (HTML → Markdown),
 * or a panel's ProseMirror `content`. The transcript is grouped into
 * speaker-turn blocks (microphone = "Me", system = "Them") since Granola's
 * segments carry a source but no per-speaker names.
 */

import type {
  GranolaDocument,
  GranolaPanel,
  GranolaTranscriptSegment,
} from "./client.ts";

/** A meeting assembled from the three Granola endpoints. */
export interface GranolaMeeting {
  document: GranolaDocument;
  panels: GranolaPanel[];
  transcript: GranolaTranscriptSegment[];
}

/** Options affecting rendered content. */
export interface RenderOptions {
  /** Include the full transcript text below the notes. */
  includeTranscript: boolean;
}

/** The rendered memory payload (content + structured metadata). */
export interface RenderedMeeting {
  title: string;
  content: string;
  meta: Record<string, unknown>;
  /** ISO start timestamp for the memory's temporal, when known. */
  startedAt?: string;
  /** ISO end timestamp for the memory's temporal, when known. */
  endedAt?: string;
}

/** A meeting's best-known start time: calendar start, else created_at. */
export function meetingStart(doc: GranolaDocument): string | undefined {
  const dt = doc.google_calendar_event?.start?.dateTime;
  if (dt && !Number.isNaN(Date.parse(dt))) return new Date(dt).toISOString();
  if (doc.created_at && !Number.isNaN(Date.parse(doc.created_at))) {
    return new Date(doc.created_at).toISOString();
  }
  return undefined;
}

/** A meeting's best-known end time: calendar end, else last transcript segment. */
function meetingEnd(
  doc: GranolaDocument,
  transcript: GranolaTranscriptSegment[],
): string | undefined {
  const dt = doc.google_calendar_event?.end?.dateTime;
  if (dt && !Number.isNaN(Date.parse(dt))) return new Date(dt).toISOString();
  const last = transcript[transcript.length - 1]?.end_timestamp;
  if (last && !Number.isNaN(Date.parse(last)))
    return new Date(last).toISOString();
  return undefined;
}

/** Attendee email list from the calendar event (deduped, lowercased). */
function attendeeEmails(doc: GranolaDocument): string[] {
  const attendees = doc.google_calendar_event?.attendees ?? [];
  const emails = new Set<string>();
  for (const a of attendees) {
    if (a.email) emails.add(a.email.toLowerCase());
  }
  return [...emails];
}

/** A human title for the meeting, with sensible fallbacks. */
export function meetingTitle(doc: GranolaDocument): string {
  const t = doc.title?.trim();
  if (t) return t;
  const cal = doc.google_calendar_event?.summary?.trim();
  if (cal) return cal;
  return "Untitled meeting";
}

/**
 * Extract the notes body as Markdown. Prefers the document's own
 * `notes_markdown`; otherwise renders the first non-empty AI summary panel.
 *
 * For a panel we prefer its ProseMirror `content` over the HTML
 * `original_content`: ProseMirror models nested lists structurally, so the
 * converter preserves indentation, whereas Granola's HTML nests `<ul>` inside
 * `<li>` and a flat regex pass would merge a child bullet into its parent line.
 * HTML is the fallback when a panel carries no structured content.
 */
export function extractNotes(meeting: GranolaMeeting): string {
  const md = meeting.document.notes_markdown?.trim();
  if (md) return md;

  for (const panel of meeting.panels) {
    const fromProse = proseMirrorToMarkdown(panel.content);
    if (fromProse.trim()) return fromProse.trim();
    const html = panel.original_content?.trim();
    if (html) return htmlToMarkdown(html);
  }

  // Last resort: the document's ProseMirror notes, if any.
  const fromDocProse = proseMirrorToMarkdown(meeting.document.notes);
  return fromDocProse.trim();
}

/**
 * Render the full meeting into a memory payload. Returns content even when
 * notes and transcript are empty (the metadata header alone is still a useful,
 * searchable record of the meeting).
 */
export function renderMeeting(
  meeting: GranolaMeeting,
  options: RenderOptions,
): RenderedMeeting {
  const { document: doc } = meeting;
  const title = meetingTitle(doc);
  const startedAt = meetingStart(doc);
  const endedAt = meetingEnd(doc, meeting.transcript);
  const emails = attendeeEmails(doc);

  const lines: string[] = [`# ${title}`, ""];
  const metaBits: string[] = [];
  if (startedAt) metaBits.push(`**Date:** ${formatDate(startedAt)}`);
  if (emails.length > 0) metaBits.push(`**Attendees:** ${emails.join(", ")}`);
  if (metaBits.length > 0) {
    lines.push(metaBits.join("  \n"), "");
  }

  const notes = extractNotes(meeting);
  if (notes) {
    lines.push("## Notes", "", notes, "");
  }

  if (options.includeTranscript && meeting.transcript.length > 0) {
    lines.push("## Transcript", "", renderTranscript(meeting.transcript), "");
  }

  const meta: Record<string, unknown> = {
    type: "granola_meeting",
    source_tool: "granola",
    source_document_id: doc.id,
    // A human label for the tree/UI (the leaf `name` is the document id, which
    // is the idempotency key); "Title — YYYY-MM-DD" so meetings read well and a
    // recurring title stays distinguishable by date.
    display_name: displayName(title, startedAt),
    content_mode: options.includeTranscript ? "with_transcript" : "notes_only",
    has_notes: notes.length > 0,
    has_transcript: meeting.transcript.length > 0,
    transcript_segment_count: meeting.transcript.length,
  };
  if (doc.workspace_id) meta.source_workspace_id = doc.workspace_id;
  if (doc.google_calendar_event?.id) {
    meta.source_calendar_event_id = doc.google_calendar_event.id;
  }
  if (emails.length > 0) meta.attendees = emails;
  if (typeof doc.valid_meeting === "boolean") {
    meta.valid_meeting = doc.valid_meeting;
  }

  return {
    title,
    content: lines.join("\n").trimEnd(),
    meta,
    startedAt,
    endedAt,
  };
}

/**
 * Render transcript segments into speaker-turn Markdown. Granola tags each
 * segment with a `source` ("microphone" = the local user, "system" = remote
 * participants) but no names, so we collapse consecutive same-source segments
 * into one labelled paragraph.
 */
function renderTranscript(segments: GranolaTranscriptSegment[]): string {
  const blocks: string[] = [];
  let currentSource: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const label = currentSource === "microphone" ? "Me" : "Them";
    blocks.push(`**${label}:** ${buffer.join(" ")}`);
    buffer = [];
  };

  for (const seg of segments) {
    const text = seg.text?.trim();
    if (!text) continue;
    if (seg.source !== currentSource) {
      flush();
      currentSource = seg.source;
    }
    buffer.push(text);
  }
  flush();
  return blocks.join("\n\n");
}

/**
 * A human display label: the title, suffixed with the meeting's calendar date
 * (`YYYY-MM-DD`, UTC) when known. Used as `meta.display_name` so the web tree
 * shows a friendly name while the leaf `name` stays the stable document id.
 */
export function displayName(title: string, startedAt?: string): string {
  if (!startedAt) return title;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return title;
  return `${title} — ${date.toISOString().slice(0, 10)}`;
}

/** Format an ISO timestamp as a readable date (UTC, no library). */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/:\d\d\.\d{3}Z$/, " UTC");
}

/**
 * Convert Granola's panel HTML into Markdown. The panels use a small, fixed
 * tag set (`h1`-`h6`, `ul`/`ol`/`li`, `p`, `strong`/`b`, `em`/`i`, `a`, `hr`,
 * `br`), so a focused converter is simpler and more predictable than pulling
 * in a general HTML→MD dependency.
 */
export function htmlToMarkdown(html: string): string {
  let out = html;

  // Links: <a href="x">text</a> → [text](x)
  out = out.replace(
    /<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, text) => `[${stripTags(text).trim()}](${href})`,
  );
  // Bold / italic.
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Headings.
  for (let level = 1; level <= 6; level++) {
    const hashes = "#".repeat(level);
    const re = new RegExp(
      `<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`,
      "gi",
    );
    out = out.replace(
      re,
      (_m, inner) => `\n${hashes} ${stripTags(inner).trim()}\n`,
    );
  }

  // List items: turn each <li> into a bullet. Nested lists are flattened with
  // indentation approximated by their depth in the original markup is lost, so
  // we keep a single level — good enough for searchable notes.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
    const text = stripTags(inner).replace(/\s+/g, " ").trim();
    return text ? `- ${text}\n` : "";
  });
  // Drop list wrappers; their items already became bullets.
  out = out.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");

  // Paragraphs and line breaks.
  out = out.replace(/<\/p>/gi, "\n\n").replace(/<p\b[^>]*>/gi, "");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Anything left over.
  out = stripTags(out);
  out = decodeEntities(out);

  // Collapse excessive blank lines.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip any remaining HTML tags. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Decode the handful of HTML entities Granola emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Render a ProseMirror document node into Markdown. Handles the node types
 * Granola's panels emit (doc, heading, paragraph, bulletList/orderedList,
 * listItem, text with bold/link marks, horizontalRule). Returns "" for an
 * empty or unrecognized input.
 */
export function proseMirrorToMarkdown(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const lines = renderProseNode(node as ProseNode, 0);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ProseNode {
  type?: string;
  text?: string;
  attrs?: { level?: number };
  marks?: Array<{ type?: string; attrs?: { href?: string } }>;
  content?: ProseNode[];
}

/** Render a ProseMirror node to an array of Markdown lines. */
function renderProseNode(node: ProseNode, listDepth: number): string[] {
  switch (node.type) {
    case "doc":
      return (node.content ?? []).flatMap((c) => [
        ...renderProseNode(c, listDepth),
        "",
      ]);
    case "heading": {
      const level = node.attrs?.level ?? 1;
      return [`${"#".repeat(level)} ${renderInline(node.content ?? [])}`];
    }
    case "paragraph":
      return [renderInline(node.content ?? [])];
    case "bulletList":
    case "orderedList":
      return (node.content ?? []).flatMap((item) =>
        renderProseNode(item, listDepth),
      );
    case "listItem": {
      const indent = "  ".repeat(listDepth);
      const parts = node.content ?? [];
      const head = parts[0] ? renderInline(parts[0].content ?? []) : "";
      const lines = [`${indent}- ${head}`];
      // Nested lists or extra paragraphs inside the item.
      for (const child of parts.slice(1)) {
        lines.push(...renderProseNode(child, listDepth + 1));
      }
      return lines;
    }
    case "horizontalRule":
      return ["---"];
    case "text":
      return [renderInline([node])];
    default:
      return node.content
        ? renderProseNode({ type: "doc", content: node.content }, listDepth)
        : [];
  }
}

/** Render inline ProseMirror nodes (text with bold/link marks) to Markdown. */
function renderInline(nodes: ProseNode[]): string {
  return nodes
    .map((n) => {
      if (n.type !== "text" || !n.text) {
        // Could be a nested inline structure; recurse on content.
        return n.content ? renderInline(n.content) : "";
      }
      let text = n.text;
      for (const mark of n.marks ?? []) {
        if (mark.type === "bold") text = `**${text}**`;
        else if (mark.type === "italic") text = `*${text}*`;
        else if (mark.type === "link" && mark.attrs?.href) {
          text = `[${text}](${mark.attrs.href})`;
        }
      }
      return text;
    })
    .join("");
}
