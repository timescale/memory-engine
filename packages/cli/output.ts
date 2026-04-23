/**
 * Output formatting utilities.
 *
 * Provides structured output (--json, --yaml) and human-readable defaults.
 * Commands use these helpers instead of console.log directly so that
 * global format flags work consistently everywhere.
 */
import { stringify as yamlStringify } from "yaml";

// =============================================================================
// Types
// =============================================================================

export type OutputFormat = "json" | "yaml" | "text";

// =============================================================================
// Format Detection
// =============================================================================

/**
 * Determine the output format from global CLI options.
 * Returns "text" when neither --json nor --yaml is set.
 */
export function getOutputFormat(opts: {
  json?: boolean;
  yaml?: boolean;
}): OutputFormat {
  if (opts.json) return "json";
  if (opts.yaml) return "yaml";
  return "text";
}

// =============================================================================
// Table Formatter
// =============================================================================

/** Module-level expanded flag, set via `setExpanded()`. */
let _expanded = false;

/**
 * Enable or disable expanded (vertical) table output.
 *
 * When enabled, `table()` renders each row as a labeled record instead of
 * a columnar table (like psql's `\x` mode).
 */
export function setExpanded(value: boolean): void {
  _expanded = value;
}

/**
 * Print a columnar table with headers and a separator line.
 *
 * Auto-sizes columns based on content width. Output is 2-space indented
 * to match existing CLI conventions. Columns are separated by 2 spaces.
 *
 * When expanded mode is active (via `-x`/`--expanded`), each row is
 * rendered vertically with labeled fields:
 *
 *   -[ RECORD 1 ]───────────────────────────────
 *   id      0194a000-0007-7000-8000-000000000007
 *   name    default
 *   org     Personal
 *   status  active
 *
 * Default (columnar) output:
 *
 *   id                                    name      org        status
 *   ──────────────────────────────────────────────────────────────────
 *   0194a000-0007-7000-8000-000000000007  default   Personal   active
 */
export function table(columns: string[], rows: string[][]): void {
  if (rows.length === 0) return;

  if (_expanded) {
    const labelWidth = Math.max(...columns.map((c) => c.length));
    for (let r = 0; r < rows.length; r++) {
      const tag = `-[ RECORD ${r + 1} ]`;
      console.log(`  ${tag}${"─".repeat(Math.max(0, 40 - tag.length))}`);
      for (let c = 0; c < columns.length; c++) {
        const val = rows[r]?.[c] ?? "";
        if (val) {
          console.log(`  ${(columns[c] ?? "").padEnd(labelWidth)}  ${val}`);
        }
      }
    }
    return;
  }

  const widths = columns.map((col, i) => {
    let max = col.length;
    for (const row of rows) {
      const len = (row[i] ?? "").length;
      if (len > max) max = len;
    }
    return max;
  });

  const header = columns.map((col, i) => col.padEnd(widths[i] ?? 0)).join("  ");
  console.log(`  ${header}`);

  const separator = widths.map((w) => "\u2500".repeat(w)).join("\u2500\u2500");
  console.log(`  ${separator}`);

  for (const row of rows) {
    const line = columns
      .map((_, i) => (row[i] ?? "").padEnd(widths[i] ?? 0))
      .join("  ");
    console.log(`  ${line}`);
  }
}

// =============================================================================
// Output Helpers
// =============================================================================

/**
 * Print structured data in the requested format.
 *
 * - json: JSON with 2-space indent
 * - yaml: YAML with no line wrapping
 * - text: calls the provided textFn for human-readable output
 *
 * Returns a Promise that resolves once the bytes are flushed to stdout.
 * Callers that pipe JSON/YAML into downstream tools (`yq`, `jq`, etc.)
 * must `await` this so the process does not exit mid-pipe-write. When
 * stdout is a pipe and the payload exceeds the kernel pipe buffer
 * (~64 KiB on macOS), the trailing bytes are silently dropped if the
 * writer exits before the reader drains.
 */
export async function output(
  data: unknown,
  format: OutputFormat,
  textFn: () => void,
): Promise<void> {
  switch (format) {
    case "json":
      await writeLineFlushed(JSON.stringify(data, null, 2));
      break;
    case "yaml":
      await writeLineFlushed(yamlStringify(data, { lineWidth: 0 }).trimEnd());
      break;
    case "text":
      textFn();
      break;
  }
}

/**
 * Write `line` + "\n" to stdout and resolve only once the kernel has
 * accepted every byte. Uses Node stream backpressure semantics so large
 * payloads (> 64 KiB pipe buffer) aren't truncated when the reader is
 * slow and the process is about to exit.
 */
async function writeLineFlushed(line: string): Promise<void> {
  const payload = `${line}\n`;
  if (!process.stdout.write(payload)) {
    await new Promise<void>((resolve) =>
      process.stdout.once("drain", () => resolve()),
    );
  }
}
