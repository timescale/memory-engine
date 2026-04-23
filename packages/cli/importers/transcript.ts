/**
 * Transcript → memory content formatter.
 *
 * Takes an `ImportedSession` and renders it as a Markdown memory body
 * suitable for storage in the engine. The caller controls whether to
 * include only user+assistant turns (default) or the full transcript
 * (reasoning, tool calls, tool results, system prompts).
 */
import type { ConversationTurn, ImportedSession } from "./types.ts";

/** Options affecting transcript rendering. */
export interface FormatOptions {
  /** Include all turn kinds (reasoning, tool_call, tool_result, system). */
  fullTranscript: boolean;
}

/** Short-form tool label for display. */
const TOOL_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * Render a conversation turn as a Markdown block.
 *
 * Each turn becomes an H3 with role + optional timestamp, then the content.
 */
function renderTurn(turn: ConversationTurn): string {
  const ts = turn.timestamp ? ` (${formatTurnTimestamp(turn.timestamp)})` : "";
  const label = turnLabel(turn);
  const header = `### ${label}${ts}`;
  const body = turn.text.trimEnd();
  return `${header}\n\n${body}`;
}

/** Display label for a turn. */
function turnLabel(turn: ConversationTurn): string {
  switch (turn.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "reasoning":
      return "assistant (reasoning)";
    case "tool_call":
      return turn.toolName ? `tool call: ${turn.toolName}` : "tool call";
    case "tool_result":
      return turn.toolName ? `tool result: ${turn.toolName}` : "tool result";
    case "system":
      return "system";
  }
}

/**
 * Format an ISO 8601 timestamp as a short `HH:MM:SS` for inline display.
 */
function formatTurnTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}Z`;
}

/**
 * Render a duration as a compact human string (e.g. "1h 26m", "4m 12s").
 */
function formatDuration(startMs: number, endMs: number): string {
  const ms = Math.max(0, endMs - startMs);
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Synthesize a session title from the first user turn when the source
 * doesn't supply one.
 */
export function synthesizeTitle(session: ImportedSession): string {
  if (session.title) return session.title;
  const firstUser = session.turns.find((t) => t.role === "user");
  if (!firstUser)
    return `${session.tool} session ${session.sessionId.slice(0, 8)}`;
  const oneLine = firstUser.text.replace(/\s+/g, " ").trim().slice(0, 80);
  return oneLine.length > 0
    ? oneLine
    : `${session.tool} session ${session.sessionId.slice(0, 8)}`;
}

/**
 * Render an imported session as memory content (Markdown).
 */
export function renderSessionContent(
  session: ImportedSession,
  options: FormatOptions,
): string {
  const title = synthesizeTitle(session);
  const toolLabel = TOOL_LABEL[session.tool] ?? session.tool;

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");

  const metaLines: string[] = [];
  metaLines.push(
    `- Tool: ${toolLabel}${session.toolVersion ? ` v${session.toolVersion}` : ""}`,
  );
  if (session.model) {
    const provider = session.provider ? `${session.provider}/` : "";
    metaLines.push(`- Model: ${provider}${session.model}`);
  }
  if (session.agentMode) {
    metaLines.push(`- Mode: ${session.agentMode}`);
  }
  if (session.cwd) {
    metaLines.push(`- Project: ${session.cwd}`);
  }
  if (session.gitBranch || session.gitCommit) {
    const branch = session.gitBranch ?? "(detached)";
    const commit = session.gitCommit
      ? ` @ ${session.gitCommit.slice(0, 7)}`
      : "";
    metaLines.push(`- Branch: ${branch}${commit}`);
  }
  const startMs = Date.parse(session.startedAt);
  const endMs = Date.parse(session.endedAt);
  if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
    metaLines.push(
      `- Duration: ${session.startedAt} → ${session.endedAt} (${formatDuration(startMs, endMs)})`,
    );
  } else {
    metaLines.push(`- Started: ${session.startedAt}`);
  }
  metaLines.push(
    `- Messages: ${session.messageCounts.user} user / ${session.messageCounts.assistant} assistant${
      session.messageCounts.tool_calls > 0
        ? ` / ${session.messageCounts.tool_calls} tool calls`
        : ""
    }`,
  );
  if (session.tokens) {
    const bits: string[] = [];
    if (session.tokens.input !== undefined)
      bits.push(`${session.tokens.input} in`);
    if (session.tokens.output !== undefined)
      bits.push(`${session.tokens.output} out`);
    if (bits.length > 0) metaLines.push(`- Tokens: ${bits.join(" / ")}`);
  }
  if (session.costUsd !== undefined) {
    metaLines.push(`- Cost: $${session.costUsd.toFixed(4)}`);
  }
  if (session.isSidechain) {
    metaLines.push("- Subagent: yes");
  }
  lines.push(...metaLines);
  lines.push("");

  const included = options.fullTranscript
    ? session.turns
    : session.turns.filter((t) => t.role === "user" || t.role === "assistant");

  if (included.length === 0) {
    lines.push("## Conversation");
    lines.push("");
    lines.push("_(no text-only turns in this session)_");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Conversation");
  lines.push("");
  for (const turn of included) {
    lines.push(renderTurn(turn));
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
