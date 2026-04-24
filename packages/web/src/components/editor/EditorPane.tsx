/**
 * Memory detail pane with view/edit modes.
 *
 * View mode: rendered markdown via `MarkdownViewer`.
 * Edit mode: Monaco editor on the frontmatter + body. Save button is
 * disabled unless the text has changed AND the frontmatter parses cleanly.
 *
 * Dirty state is mirrored into the global `useEditor` store so the tree
 * view can prompt before discarding changes on navigation. A beforeunload
 * listener handles the "close tab / refresh" path.
 */

import type { MemoryResponse } from "@memory.build/client";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useUpdateMemory } from "../../api/queries.ts";
import { memoryToEditorText, parseEditorText } from "../../lib/frontmatter.ts";
import { useEditor } from "../../store/editor.ts";
import { pushToast } from "../toast/Toast.tsx";
import { FrontmatterBlock } from "../viewer/FrontmatterBlock.tsx";
import { MarkdownViewer } from "../viewer/MarkdownViewer.tsx";

// Monaco is ~3 MB minified; lazy-load it so the initial page render stays fast
// and users who never edit never download it.
const MonacoMarkdownEditor = lazy(async () => {
  const mod = await import("./MonacoMarkdownEditor.tsx");
  return { default: mod.MonacoMarkdownEditor };
});

type Mode = "view" | "edit";

interface Props {
  memory: MemoryResponse;
  /** Opens the delete confirmation dialog. Wired in step 11. */
  onRequestDelete?: () => void;
}

function EditorLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-slate-500">
      Loading editor…
    </div>
  );
}

export function EditorPane({ memory, onRequestDelete }: Props) {
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
      // Send the diff: server accepts null to clear a field.
      await update.mutateAsync({
        id: memory.id,
        content: fm.body,
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

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        memory={memory}
        mode={mode}
        onToggleMode={() => setMode(mode === "view" ? "edit" : "view")}
        dirty={dirty}
        canSave={canSave}
        saving={update.isPending}
        saveError={update.error}
        onCopy={handleCopy}
        onSave={handleSave}
        onDelete={onRequestDelete}
      />

      {!parsed.ok && mode === "edit" && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          Frontmatter error: {parsed.error}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {mode === "view" ? (
          <div className="h-full overflow-auto p-6">
            {parsed.ok && <FrontmatterBlock frontmatter={parsed.value} />}
            <MarkdownViewer content={parsed.ok ? parsed.value.body : text} />
          </div>
        ) : (
          <Suspense fallback={<EditorLoading />}>
            <MonacoMarkdownEditor value={text} onChange={setText} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

interface ToolbarProps {
  memory: MemoryResponse;
  mode: Mode;
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  saveError: Error | null;
  onToggleMode: () => void;
  onCopy: () => void;
  onSave: () => void;
  onDelete?: () => void;
}

function Toolbar({
  memory,
  mode,
  dirty,
  canSave,
  saving,
  saveError,
  onToggleMode,
  onCopy,
  onSave,
  onDelete,
}: ToolbarProps) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs uppercase tracking-wide text-slate-400">
          {memory.tree || "(root)"}
        </p>
        {saveError && (
          <p className="mt-1 text-xs text-red-600">
            Save failed: {saveError.message}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {dirty && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
            unsaved
          </span>
        )}
        <button
          type="button"
          onClick={onCopy}
          title="Copy Markdown"
          aria-label="Copy Markdown"
          className="rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-100"
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          onClick={onToggleMode}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          {mode === "view" ? "Edit" : "Preview"}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!onDelete}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </header>
  );
}
