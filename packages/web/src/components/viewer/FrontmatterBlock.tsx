/**
 * Collapsible frontmatter display for view mode.
 *
 * Re-serializes the parsed frontmatter back to YAML and renders it inside
 * a `<details>` element. Highlighting reuses the existing react-markdown +
 * rehype-highlight pipeline by wrapping the YAML in a fenced code block —
 * no second syntax-highlighter dependency, and the colors match the body's
 * code blocks exactly.
 *
 * Returns `null` when there is nothing to show (no tree, empty meta, no
 * temporal) so the view-mode pane stays uncluttered for bare memories.
 */

import yaml from "js-yaml";
import { useMemo } from "react";
import type { ParsedFrontmatter } from "../../lib/frontmatter.ts";
import { MarkdownViewer } from "./MarkdownViewer.tsx";

type Frontmatter = Pick<ParsedFrontmatter, "tree" | "meta" | "temporal">;

interface Props {
  frontmatter: Frontmatter;
}

function toYamlMarkdown(fm: Frontmatter): string | null {
  const obj: Record<string, unknown> = {};
  if (fm.tree) obj.tree = fm.tree;
  if (fm.meta && Object.keys(fm.meta).length > 0) obj.meta = fm.meta;
  if (fm.temporal) obj.temporal = fm.temporal;
  if (Object.keys(obj).length === 0) return null;

  const yamlText = yaml.dump(obj, { lineWidth: 0, noRefs: true }).trimEnd();
  return `\`\`\`yaml\n${yamlText}\n\`\`\``;
}

export function FrontmatterBlock({ frontmatter }: Props) {
  const markdown = useMemo(() => toYamlMarkdown(frontmatter), [frontmatter]);
  if (markdown === null) return null;

  return (
    <details className="mb-4 rounded-md border border-slate-200 bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700">
        Frontmatter
      </summary>
      <div className="frontmatter-yaml border-t border-slate-200 px-3 py-2">
        <MarkdownViewer content={markdown} />
      </div>
    </details>
  );
}
