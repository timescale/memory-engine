/**
 * Top-level app component.
 *
 * Layout (the "Console" redesign):
 *   - Header bar: logo + product name, space switcher + account.
 *   - Search/controls bar: search field + Simple/Advanced toggle + Clear +
 *     refresh.
 *   - Body: a fixed-width "explorer" sidebar (tree), an optional
 *     search-results column, and a flex-grow main pane showing the selected
 *     memory. Three-pane while searching, two-pane otherwise.
 *
 * Left pane: the `TreeView`, which runs in one of two modes depending on
 * whether the filter has any active criteria. Browse mode renders the full
 * path hierarchy from `memory.tree` with leaves loaded lazily per expanded
 * path; search mode renders matching memories from `memory.search`.
 *
 * Middle column (only while the filter has at least one criterion — text
 * or tree/meta/temporal): relevance-sorted search results. A new search
 * starts as a full-width list with the top result selected; clicking a
 * result opens the preview beside it (see SearchResultsPane), after which
 * the column is resizable.
 *
 * Right pane: the editor/viewer for the currently selected memory, fetched
 * by id. While searching it can be hidden (the X in its toolbar) to let the
 * results column fill the space; selecting a result reveals it again. URL
 * state carries the selection + filter for shareable links.
 */

import type { MemoryResponse } from "@memory.build/client";
import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useMemory, useTree } from "./api/queries.ts";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { DeleteMemoryDialog } from "./components/dialogs/DeleteMemoryDialog.tsx";
import { DeleteTreeDialog } from "./components/dialogs/DeleteTreeDialog.tsx";
import { EditorPane } from "./components/editor/EditorPane.tsx";
import { CloseIcon } from "./components/icons.tsx";
import { ColumnResizer } from "./components/layout/ColumnResizer.tsx";
import { ExplorerHeader } from "./components/layout/ExplorerHeader.tsx";
import { HeaderBar } from "./components/layout/HeaderBar.tsx";
import { AdvancedSearchSection } from "./components/search/AdvancedSearchSection.tsx";
import { SearchResultsPane } from "./components/search/SearchResultsPane.tsx";
import { SimpleSearchBar } from "./components/search/SimpleSearchBar.tsx";
import { TreeView } from "./components/TreeView.tsx";
import { ToastStack } from "./components/toast/Toast.tsx";
import { expansionPathsForMemoryTree } from "./lib/tree-build.ts";
import { useActiveSearch } from "./lib/useActiveSearch.ts";
import { useUrlSync } from "./lib/useUrlSync.ts";
import { confirmDiscardChangesIfDirty } from "./store/editor.ts";
import { useFilter } from "./store/filter.ts";
import {
  MAX_SEARCH_COLUMN_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SEARCH_COLUMN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useLayout,
} from "./store/layout.ts";
import { useSelection } from "./store/selection.ts";
import { useUi } from "./store/ui.ts";

export function App() {
  useUrlSync();

  const filterMode = useFilter(useShallow((s) => s.mode));

  const tree = useTree();
  const selectedId = useSelection((s) => s.selectedId);
  const setExpanded = useSelection((s) => s.setExpanded);
  const { data: selectedMemory } = useMemory(selectedId);
  const sidebarWidth = useLayout((s) => s.sidebarWidth);
  const setSidebarWidth = useLayout((s) => s.setSidebarWidth);
  const searchColumnWidth = useLayout((s) => s.searchColumnWidth);
  const setSearchColumnWidth = useLayout((s) => s.setSearchColumnWidth);
  const searchPreviewCollapsed = useLayout((s) => s.searchPreviewCollapsed);
  const setSearchPreviewCollapsed = useLayout(
    (s) => s.setSearchPreviewCollapsed,
  );
  const { searchActive } = useActiveSearch();

  // The preview collapse only applies to the search layout — in browse mode
  // the editor is the main content and always shows.
  const previewVisible = !searchActive || !searchPreviewCollapsed;
  const closePreview = () => {
    // Hiding the pane unmounts the editor, so unsaved edits need the same
    // confirm as navigating away.
    if (!confirmDiscardChangesIfDirty()) return;
    setSearchPreviewCollapsed(true);
  };

  useEffect(() => {
    if (!selectedMemory) return;
    for (const path of expansionPathsForMemoryTree(selectedMemory.tree)) {
      setExpanded("browse", path, true);
      setExpanded("search", path, true);
    }
  }, [selectedMemory, setExpanded]);

  const totalMemories = tree.data
    ? sumTopLevelAggregate(tree.data.nodes)
    : null;

  return (
    <div className="flex h-full flex-col">
      <HeaderBar />

      <div className="shrink-0 border-b border-ink/[0.12] px-6 py-4">
        {filterMode === "simple" ? (
          <SimpleSearchBar />
        ) : (
          <AdvancedSearchSection />
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r border-ink/[0.12]"
          style={{ width: sidebarWidth }}
        >
          <ExplorerHeader count={totalMemories} />
          <div className="min-h-0 flex-1">
            <TreeView />
          </div>
        </aside>
        <ColumnResizer
          label="Resize sidebar"
          min={MIN_SIDEBAR_WIDTH}
          max={MAX_SIDEBAR_WIDTH}
          value={sidebarWidth}
          onChange={setSidebarWidth}
        />

        {searchActive && (
          <>
            <SearchResultsPane />
            {previewVisible && (
              <ColumnResizer
                label="Resize search results"
                min={MIN_SEARCH_COLUMN_WIDTH}
                max={MAX_SEARCH_COLUMN_WIDTH}
                value={searchColumnWidth}
                onChange={setSearchColumnWidth}
              />
            )}
          </>
        )}

        {previewVisible && (
          <main className="min-w-0 flex-1 overflow-hidden">
            {selectedMemory ? (
              <SelectedMemoryPane
                memory={selectedMemory}
                onClose={searchActive ? closePreview : undefined}
              />
            ) : (
              <EmptyPane
                selectedId={selectedId}
                searching={searchActive}
                onClose={searchActive ? closePreview : undefined}
              />
            )}
          </main>
        )}
      </div>

      <ContextMenu />
      <DeleteMemoryDialog />
      <DeleteTreeDialog />
      <ToastStack />
    </div>
  );
}

function EmptyPane({
  onClose,
  searching,
  selectedId,
}: {
  onClose?: () => void;
  searching: boolean;
  selectedId: string | null;
}) {
  return (
    <div className="relative flex h-full items-center justify-center px-6">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title="Hide preview"
          aria-label="Hide preview"
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink/[0.18] text-ink/70 transition-colors hover:border-ink hover:text-ink"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      )}
      <p className="text-[13px] text-ink/50">
        {selectedId
          ? "Loading memory…"
          : searching
            ? "Select a search result to preview it."
            : "Select a memory from the tree to view its contents."}
      </p>
    </div>
  );
}

function SelectedMemoryPane({
  memory,
  onClose,
}: {
  memory: MemoryResponse;
  onClose?: () => void;
}) {
  const askDeleteMemory = useUi((s) => s.askDeleteMemory);
  const firstLine =
    memory.content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l) ?? memory.id.slice(-8);
  return (
    <EditorPane
      memory={memory}
      onRequestDelete={() =>
        askDeleteMemory({ id: memory.id, title: firstLine })
      }
      onClose={onClose}
    />
  );
}

/**
 * Sum aggregate counts of top-level paths (= total memories excluding
 * empty-tree ones). Empty-tree memories are counted via a separate query
 * and added to this elsewhere when needed.
 */
function sumTopLevelAggregate(
  nodes: { path: string; count: number }[],
): number {
  return nodes
    .filter((n) => !n.path.includes("."))
    .reduce((sum, n) => sum + n.count, 0);
}
