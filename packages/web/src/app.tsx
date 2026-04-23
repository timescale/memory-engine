/**
 * Top-level app component.
 *
 * Step 8 wiring:
 * - Reads filter state from the store, debounces it, feeds it to
 *   `useMemories`.
 * - Syncs filter + selection state to the URL so views are shareable.
 * - Renders the simple search bar in the header.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useMemories } from "./api/queries.ts";
import type { MemoryWithScore } from "./api/types.ts";
import { DeleteMemoryDialog } from "./components/dialogs/DeleteMemoryDialog.tsx";
import { DeleteTreeDialog } from "./components/dialogs/DeleteTreeDialog.tsx";
import { EditorPane } from "./components/editor/EditorPane.tsx";
import { AdvancedSearchPanel } from "./components/search/AdvancedSearchPanel.tsx";
import { SimpleSearchBar } from "./components/search/SimpleSearchBar.tsx";
import { ToastStack } from "./components/toast/Toast.tsx";
import { ContextMenu } from "./components/tree/ContextMenu.tsx";
import { TreeView } from "./components/tree/TreeView.tsx";
import { MetadataPanel } from "./components/viewer/MetadataPanel.tsx";
import { useDebounced } from "./lib/useDebounced.ts";
import { useUrlSync } from "./lib/useUrlSync.ts";
import { selectSearchParams, useFilter } from "./store/filter.ts";
import { useSelection } from "./store/selection.ts";
import { useUi } from "./store/ui.ts";

export function App() {
  useUrlSync();

  const filterState = useFilter(
    useShallow((s) => ({
      mode: s.mode,
      simple: s.simple,
      advanced: s.advanced,
    })),
  );
  const debouncedFilter = useDebounced(filterState, 250);
  const searchParams = useMemo(
    () => selectSearchParams(debouncedFilter),
    [debouncedFilter],
  );

  const { data, error, isLoading, isFetching } = useMemories(searchParams);
  const memories = data?.results ?? [];

  const selectedId = useSelection((s) => s.selectedId);
  const selectedMemory = useMemo(
    () => memories.find((m) => m.id === selectedId) ?? null,
    [memories, selectedId],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-900">
            Memory Engine
          </h1>
          <p className="text-xs text-slate-500">
            {data
              ? `${data.results.length} / ${data.total} memories${isFetching ? " · refreshing…" : ""}`
              : "Loading…"}
          </p>
        </div>
        <SimpleSearchBar />
        {filterState.mode === "advanced" && (
          <div className="mt-3">
            <AdvancedSearchPanel />
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-auto border-r border-slate-200 bg-white">
          <TreeView
            memories={memories}
            isLoading={isLoading}
            error={error instanceof Error ? error : null}
          />
        </aside>

        <main className="min-w-0 flex-1 overflow-auto bg-slate-50">
          {selectedMemory ? (
            <SelectedMemoryPane memory={selectedMemory} />
          ) : (
            <EmptyPane />
          )}
        </main>
      </div>

      <ContextMenu />
      <DeleteMemoryDialog />
      <DeleteTreeDialog />
      <ToastStack />
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-slate-500">
        Select a memory from the tree to view its contents.
      </p>
    </div>
  );
}

function SelectedMemoryPane({ memory }: { memory: MemoryWithScore }) {
  const askDeleteMemory = useUi((s) => s.askDeleteMemory);
  const firstLine =
    memory.content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l) ?? memory.id.slice(-8);
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden">
        <EditorPane
          memory={memory}
          onRequestDelete={() =>
            askDeleteMemory({ id: memory.id, title: firstLine })
          }
        />
      </div>
      <section className="shrink-0 border-t border-slate-200 bg-white px-4 py-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Metadata
        </h2>
        <MetadataPanel memory={memory} />
      </section>
    </div>
  );
}
