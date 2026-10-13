/**
 * Small copy-to-clipboard button for a `<details>` summary heading.
 *
 * The button sits inside `<summary>`, so a click must not toggle the
 * disclosure: the handler prevents the default summary action.
 */
import type { MouseEvent } from "react";
import { CopyIcon } from "../icons.tsx";
import { pushToast } from "../toast/Toast.tsx";

interface Props {
  /** Text to put on the clipboard. */
  text: string;
  /** Section name for the tooltip and the toast, e.g. "frontmatter". */
  label: string;
}

export function SummaryCopyButton({ text, label }: Props) {
  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      pushToast(`Copied ${label} to clipboard`, "success");
    } catch (err) {
      pushToast(
        `Copy failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
        5000,
      );
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="float-right -my-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-ink/40 hover:bg-tiger-blue/10 hover:text-tiger-blue-strong"
    >
      <CopyIcon className="h-3.5 w-3.5" />
    </button>
  );
}
