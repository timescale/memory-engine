/**
 * Markdown renderer.
 *
 * Uses `react-markdown` with `remark-gfm` (tables, strikethrough, task
 * lists, autolinks) and `rehype-highlight` (syntax highlighting via
 * highlight.js — the dark Tiger-palette theme is in `styles.css`).
 *
 * Fenced code blocks render as dark "code cards": a header strip showing the
 * language eyebrow above a dark `<pre>` body.
 */
import {
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

interface Props {
  content: string;
}

export function MarkdownViewer({ content }: Props) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ pre: CodeCard }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Dark code card with a language eyebrow header strip. */
function CodeCard({
  children,
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const language = extractLanguage(children);
  return (
    <div className="my-6 overflow-hidden rounded-lg border border-ink/[0.14]">
      <div className="flex items-center justify-between border-b border-code-border bg-code px-3.5 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#a1a1aa]">
          {language ?? "code"}
        </span>
      </div>
      <pre
        {...rest}
        className="m-0 overflow-auto bg-code p-4 font-mono text-[13px] leading-[1.7] text-[#d4d4d8]"
      >
        {children}
      </pre>
    </div>
  );
}

/** Pull the `language-xxx` token off the inner <code> element, if present. */
function extractLanguage(children: ReactNode): string | undefined {
  if (!isValidElement(children)) return undefined;
  const className = (children.props as { className?: string }).className ?? "";
  return /language-([\w-]+)/.exec(className)?.[1];
}
