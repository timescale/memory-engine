/**
 * Per-message content rendering.
 *
 * Each source-native message becomes one memory. The memory's content is
 * the raw text of the message's blocks:
 *
 *   - Default mode keeps only `text` blocks. Messages with no text blocks
 *     produce no memory (caller checks for `null` and skips).
 *   - `--full-transcript` mode keeps every block kind, joining them with
 *     blank lines. Non-text block kinds are machine-classified via
 *     `message.role` and `meta.source_message_block_kinds`, so the content
 *     stays as raw text with no inline labels.
 */
import type { ConversationMessage, ImportedSession } from "./types.ts";

/** Options affecting message rendering. */
export interface FormatOptions {
  /** Include all block kinds (reasoning, tool_call, tool_result, system). */
  fullTranscript: boolean;
}

/**
 * Render a single message's content, or return null if no content should
 * be stored for this message under the given options.
 */
export function renderMessageContent(
  message: ConversationMessage,
  options: FormatOptions,
): string | null {
  const blocks = options.fullTranscript
    ? message.blocks
    : message.blocks.filter((b) => b.kind === "text");
  if (blocks.length === 0) return null;
  const content = blocks
    .map((b) => b.text.trimEnd())
    .filter((t) => t.length > 0)
    .join("\n\n");
  return content.length > 0 ? content : null;
}

/**
 * Synthesize a session title from the first user message's text when the
 * source doesn't supply one. Used for logging / failure reporting.
 */
export function synthesizeTitle(session: ImportedSession): string {
  if (session.title) return session.title;
  const firstUser = session.messages.find(
    (m) => m.role === "user" && m.blocks.some((b) => b.kind === "text"),
  );
  if (!firstUser) {
    return `${session.tool} session ${session.sessionId.slice(0, 8)}`;
  }
  const textBlock = firstUser.blocks.find((b) => b.kind === "text");
  const text = textBlock?.text ?? "";
  const oneLine = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return oneLine.length > 0
    ? oneLine
    : `${session.tool} session ${session.sessionId.slice(0, 8)}`;
}
