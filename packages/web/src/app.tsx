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
 * Middle column (only while a text filter is active): relevance-sorted
 * search results, resizable. When a result set arrives, the top result is
 * auto-selected so the preview reflects the search (see SearchResultsPane);
 * selecting another result opens it without losing the list.
 *
 * Right pane: the editor/viewer for the currently selected memory, fetched
 * by id. URL state carries the selection + filter for shareable links.
 */

import type { MemoryResponse } from "@memory.build/client";
import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useMemory, useTree } from "./api/queries.ts";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { DeleteMemoryDialog } from "./components/dialogs/DeleteMemoryDialog.tsx";
import { DeleteTreeDialog } from "./components/dialogs/DeleteTreeDialog.tsx";
import { EditorPane } from "./components/editor/EditorPane.tsx";
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
  const { textFilterActive } = useActiveSearch();

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

        {textFilterActive && (
          <>
            <SearchResultsPane />
            <ColumnResizer
              label="Resize search results"
              min={MIN_SEARCH_COLUMN_WIDTH}
              max={MAX_SEARCH_COLUMN_WIDTH}
              value={searchColumnWidth}
              onChange={setSearchColumnWidth}
            />
          </>
        )}

        <main className="min-w-0 flex-1 overflow-hidden">
          {selectedMemory ? (
            <SelectedMemoryPane memory={selectedMemory} />
          ) : (
            <EmptyPane selectedId={selectedId} searching={textFilterActive} />
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

function EmptyPane({
  searching,
  selectedId,
}: {
  searching: boolean;
  selectedId: string | null;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
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

function SelectedMemoryPane({ memory }: { memory: MemoryResponse }) {
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
