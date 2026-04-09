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
// Output Helpers
// =============================================================================

/**
 * Print structured data in the requested format.
 *
 * - json: JSON with 2-space indent
 * - yaml: YAML with no line wrapping
 * - text: calls the provided textFn for human-readable output
 */
export function output(
  data: unknown,
  format: OutputFormat,
  textFn: () => void,
): void {
  switch (format) {
    case "json":
      console.log(JSON.stringify(data, null, 2));
      break;
    case "yaml":
      console.log(yamlStringify(data, { lineWidth: 0 }).trimEnd());
      break;
    case "text":
      textFn();
      break;
  }
}
