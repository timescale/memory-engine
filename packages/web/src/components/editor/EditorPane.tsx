/**
 * Memory detail pane with view/edit modes.
 *
 * View mode: the "Console" reading layout — breadcrumb, title, meta row,
 * rendered markdown body, tag pills, and a collapsible details/metadata
 * section. A slim action cluster (Edit / Copy / Delete) sits on the
 * breadcrumb row.
 *
 * Edit mode: a toolbar (Preview / Save / Delete) above a Monaco editor on the
 * frontmatter + body. Save is disabled unless the text changed AND the
 * frontmatter parses cleanly.
 *
 * Dirty state is mirrored into the global `useEditor` store so the tree
 * view can prompt before discarding changes on navigation. A beforeunload
 * listener handles the "close tab / refresh" path.
 */

import {
  META_NEXT,
  META_PREV,
  META_THREAD,
  type MemoryResponse,
  memoryPath,
} from "@memory.build/client";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  useMemoryByPath,
  useNextByPrev,
  useUpdateMemory,
} from "../../api/queries.ts";
import { memoryToEditorText, parseEditorText } from "../../lib/frontmatter.ts";
import {
  breadcrumbSegments,
  deriveTitleAndBody,
  extractTags,
  formatShortDate,
} from "../../lib/memory-view.ts";
import { confirmDiscardChangesIfDirty, useEditor } from "../../store/editor.ts";
import { useFilter } from "../../store/filter.ts";
import { useLayout } from "../../store/layout.ts";
import { useSelection } from "../../store/selection.ts";
import { CloseIcon } from "../icons.tsx";
import { pushToast } from "../toast/Toast.tsx";
import { FrontmatterBlock } from "../viewer/FrontmatterBlock.tsx";
import { MarkdownViewer } from "../viewer/MarkdownViewer.tsx";
import { MetadataPanel } from "../viewer/MetadataPanel.tsx";

// Monaco is ~3 MB minified; lazy-load it so the initial page render stays fast
// and users who never edit never download it.
const MonacoMarkdownEditor = lazy(async () => {
  const mod = await import("./MonacoMarkdownEditor.tsx");
  return { default: mod.MonacoMarkdownEditor };
});

type Mode = "view" | "edit";

interface Props {
  memory: MemoryResponse;
  onRequestDelete?: () => void;
  /** Hide the preview pane (search layout). Rendered as an X in the toolbar. */
  onClose?: () => void;
}

function EditorLoading() {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-ink/50">
      Loading editor…
    </div>
  );
}

export function EditorPane({ memory, onRequestDelete, onClose }: Props) {
  const queryClient = useQueryClient();
  const update = useUpdateMemory(queryClient);

  const originalText = useMemo(() => memoryToEditorText(memory), [memory]);
  const [mode, setMode] = useState<Mode>("view");
  const [text, setText] = useState(originalText);

  // Reset editor state whenever the selected memory changes.
  useEffect(() => {
    setText(originalText);
    setMode("view");
  }, [originalText]);

  const dirty = text !== originalText;
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: parseEditorText(text) };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [text]);

  // Sync the dirty flag into the global store + guard page unload.
  const setGlobalDirty = useEditor((s) => s.setDirty);
  useEffect(() => {
    setGlobalDirty(dirty);
    return () => setGlobalDirty(false);
  }, [dirty, setGlobalDirty]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const canSave = dirty && parsed.ok && !update.isPending;

  async function handleSave() {
    if (!parsed.ok) return;
    const fm = parsed.value;
    try {
      // Send the diff: server accepts null to clear a field. Omitting `name`
      // from the frontmatter clears it (parsed as null); a slug sets/renames.
      await update.mutateAsync({
        id: memory.id,
        versionHash: memory.versionHash,
        content: fm.body,
        name: fm.name,
        tree: fm.tree,
        meta: fm.meta,
        temporal: fm.temporal,
      });
      pushToast("Memory saved", "success");
    } catch (err) {
      pushToast(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
        5000,
      );
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("Copied markdown to clipboard", "success");
    } catch (err) {
      pushToast(
        `Copy failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
        5000,
      );
    }
  }

  const toggleMode = () => setMode(mode === "view" ? "edit" : "view");

  if (mode === "view") {
    return (
      <ReadingView
        memory={memory}
        onEdit={toggleMode}
        onCopy={handleCopy}
        onDelete={onRequestDelete}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink/[0.12] px-6 py-3">
        <Breadcrumb tree={memory.tree} />
        {saveErrorText(update.error) && (
          <span className="font-mono text-[11px] text-tiger-red">
            {saveErrorText(update.error)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <span className="font-mono text-[11px] text-ink/55">unsaved</span>
          )}
          <IconButton title="Copy Markdown" onClick={handleCopy}>
            <CopyIcon />
          </IconButton>
          <GhostButton onClick={toggleMode}>Preview</GhostButton>
          <PrimaryButton onClick={handleSave} disabled={!canSave}>
            {update.isPending ? "Saving…" : "Save"}
          </PrimaryButton>
          <GhostButton
            onClick={onRequestDelete}
            disabled={!onRequestDelete}
            danger
          >
            Delete
          </GhostButton>
          {onClose && (
            <IconButton title="Hide preview" onClick={onClose}>
              <CloseIcon className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </header>

      {!parsed.ok && (
        <div className="border-b border-tiger-red/40 bg-tiger-red/10 px-6 py-2 font-mono text-[11px] text-ink/70">
          Frontmatter error: {parsed.error}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<EditorLoading />}>
          <MonacoMarkdownEditor value={text} onChange={setText} />
        </Suspense>
      </div>
    </div>
  );
}

function ReadingView({
  memory,
  onEdit,
  onCopy,
  onDelete,
  onClose,
}: {
  memory: MemoryResponse;
  onEdit: () => void;
  onCopy: () => void;
  onDelete?: () => void;
  onClose?: () => void;
}) {
  const { title, body } = useMemo(
    () => deriveTitleAndBody(memory.content, memory.name),
    [memory.content, memory.name],
  );
  const parsedFrontmatter = useMemo(() => {
    try {
      return parseEditorText(memoryToEditorText(memory));
    } catch {
      return null;
    }
  }, [memory]);
  const tags = extractTags(memory.meta);

  return (
    <div className="h-full overflow-auto px-11 py-[34px]">
      <article className="max-w-[760px]">
        <div className="mb-3.5 flex items-start justify-between gap-4">
          <Breadcrumb tree={memory.tree} />
          <div className="flex shrink-0 items-center gap-2">
            <GhostButton onClick={onEdit}>Edit</GhostButton>
            <IconButton title="Copy Markdown" onClick={onCopy}>
              <CopyIcon />
            </IconButton>
            <IconButton
              title="Delete memory"
              onClick={onDelete}
              disabled={!onDelete}
              danger
            >
              <TrashIcon />
            </IconButton>
            {onClose && (
              <IconButton title="Hide preview" onClick={onClose}>
                <CloseIcon className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        </div>

        <h1 className="mb-4 text-[31px] font-bold leading-[1.12] tracking-[-0.025em] text-ink">
          {title}
        </h1>

        <MetaRow memory={memory} />

        <div className="mt-[26px]">
          <MarkdownViewer content={body} />
        </div>

        {tags.length > 0 && (
          <div className="mt-[26px] flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-[7px] rounded-full border border-ink/[0.16] px-[11px] py-1 font-mono text-[12px] text-ink/80"
              >
                <span className="size-[5px] rounded-full bg-tiger-blue" />
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mt-10 space-y-4 border-t border-ink/10 pt-6">
          {parsedFrontmatter && (
            <FrontmatterBlock frontmatter={parsedFrontmatter} />
          )}
          <MetadataPanel memory={memory} />
        </div>

        <ThreadNav memory={memory} />
      </article>
    </div>
  );
}

/**
 * Thread navigation: Previous / Next / Entire thread, shown when the memory
 * carries the reserved link keys. `$prev` (and a stored `$next`) are canonical
 * paths resolved to their memory; when `$next` is absent it is derived from
 * `$prev` (the memory pointing back at this one). If several memories share
 * that `$prev` (a branching git history), navigating to one would be arbitrary,
 * so instead we show a **Find next** button that pre-populates the search with
 * all of them. `$thread` filters search to the whole thread. Renders nothing
 * for a memory with no links.
 */
function ThreadNav({ memory }: { memory: MemoryResponse }) {
  const select = useSelection((s) => s.select);
  const applyMetaJsonFilter = useFilter((s) => s.applyMetaJsonFilter);
  const setAdvanced = useFilter((s) => s.setAdvanced);
  const setSearchCollapsed = useLayout((s) => s.setSearchCollapsed);

  const meta = memory.meta;
  const asString = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const prevPath = asString(meta[META_PREV]);
  const storedNextPath = asString(meta[META_NEXT]);
  const threadId = asString(meta[META_THREAD]);
  const currentPath = memory.name ? memoryPath(memory.tree, memory.name) : null;

  const prev = useMemoryByPath(prevPath);
  const storedNext = useMemoryByPath(storedNextPath);
  // Derive next candidates only when there's no stored $next and this memory is
  // addressable by path (named).
  const deriveEnabled = storedNextPath === null && currentPath !== null;
  const derivedNext = useNextByPrev(
    deriveEnabled ? { path: currentPath as string, thread: threadId } : null,
  );
  const derivedNexts = derivedNext.data ?? [];

  // An explicit stored $next is always a single target; a derived next is
  // unique only when exactly one memory points back. Two or more means the
  // thread forks here — offer a search instead of an arbitrary jump.
  const singleNext =
    storedNextPath !== null
      ? storedNext.data
      : derivedNexts.length === 1
        ? derivedNexts[0]
        : undefined;
  const showSingleNext = storedNextPath !== null || derivedNexts.length === 1;
  const forkedNext = storedNextPath === null && derivedNexts.length > 1;

  const navigate = (id: string | undefined) => {
    if (!id || id === memory.id) return;
    if (!confirmDiscardChangesIfDirty()) return;
    select(id);
  };

  // Pre-populate search with everything whose $prev points back here.
  const searchForNext = () => {
    if (currentPath === null) return;
    const filter: Record<string, unknown> = { [META_PREV]: currentPath };
    if (threadId !== null) filter[META_THREAD] = threadId;
    applyMetaJsonFilter(filter);
    setSearchCollapsed(false);
  };

  const showPrev = prevPath !== null;
  const showThread = threadId !== null;
  if (!showPrev && !showSingleNext && !forkedNext && !showThread) return null;

  return (
    // 3 columns so "Entire thread" stays centered even when Previous or Next is
    // absent: Previous left, thread centered, Next right.
    <nav className="mt-8 grid grid-cols-3 items-center gap-2 border-t border-ink/10 pt-6">
      <div className="justify-self-start">
        {showPrev && (
          <GhostButton
            onClick={() => navigate(prev.data?.id)}
            disabled={!prev.data}
          >
            ← Previous
          </GhostButton>
        )}
      </div>
      <div className="justify-self-center">
        {showThread && (
          <GhostButton
            onClick={() => {
              // Filter to the thread, oldest-first (uuidv7 id order = message
              // order for imported threads). No advanced-panel popup — the
              // overlay would cover the very results this asks for.
              applyMetaJsonFilter({ [META_THREAD]: threadId });
              setAdvanced({ orderBy: "asc" });
            }}
          >
            Entire thread
          </GhostButton>
        )}
      </div>
      <div className="justify-self-end">
        {showSingleNext && (
          <GhostButton
            onClick={() => navigate(singleNext?.id)}
            disabled={!singleNext}
          >
            Next →
          </GhostButton>
        )}
        {forkedNext && (
          <GhostButton onClick={searchForNext}>Find next →</GhostButton>
        )}
      </div>
    </nav>
  );
}

function MetaRow({ memory }: { memory: MemoryResponse }) {
  return (
    <div className="flex flex-wrap items-center gap-[13px] font-mono text-[12px] text-ink/[0.62]">
      <span>created {formatShortDate(memory.createdAt)}</span>
      {memory.updatedAt && (
        <>
          <MetaDot />
          <span>updated {formatShortDate(memory.updatedAt)}</span>
        </>
      )}
      <MetaDot />
      <span>{memory.hasEmbedding ? "embedded" : "embedding pending"}</span>
      {memory.version > 1 && (
        <>
          <MetaDot />
          <span>v{memory.version}</span>
        </>
      )}
    </div>
  );
}

function MetaDot() {
  return <span className="text-ink/40">·</span>;
}

function Breadcrumb({ tree }: { tree: string }) {
  const segments = breadcrumbSegments(tree);
  if (segments.length === 0) {
    return <div className="font-mono text-[12px] text-ink/50">/</div>;
  }
  return (
    <div className="min-w-0 truncate font-mono text-[12px] tracking-[0.03em] text-ink/50">
      {segments.map((segment, index) => (
        <span key={segments.slice(0, index + 1).join(".")}>
          {index > 0 && <span className="px-1.5 text-ink/30">/</span>}
          {segment}
        </span>
      ))}
    </div>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "inline-flex h-8 items-center rounded-md border px-3 text-[12px] font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "border-ink/[0.18] text-ink/70 hover:border-tiger-red hover:text-tiger-red"
          : "border-ink/[0.18] text-ink hover:border-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center rounded-md bg-solar px-3 text-[12px] font-semibold text-ink transition-colors hover:bg-solar-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-solar"
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={[
        "inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "border-ink/[0.18] text-ink/70 hover:border-tiger-red hover:text-tiger-red"
          : "border-ink/[0.18] text-ink/70 hover:border-ink hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function saveErrorText(error: Error | null): string | null {
  return error ? `Save failed: ${error.message}` : null;
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
