/**
 * Markdown renderer.
 *
 * Uses `react-markdown` with `remark-gfm` (tables, strikethrough, task
 * lists, autolinks) and `rehype-highlight` (syntax highlighting via
 * highlight.js). The syntax theme is imported once from `styles.css`.
 */
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
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
