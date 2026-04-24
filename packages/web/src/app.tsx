/**
 * Top-level app component.
 *
 * Left pane: the `TreeView`, which runs in one of two modes depending on
 * whether the filter has any active criteria. Browse mode renders the
 * full path hierarchy from `memory.tree` with leaves loaded lazily per
 * expanded path; search mode renders a tree of matching memories from
 * `memory.search`. The header's filter UI (simple / advanced) is the only
 * place that drives the mode switch.
 *
 * Right pane: the editor/viewer for the currently selected memory, fetched
 * by id. URL state carries the selection + filter for shareable links.
 */

import type { MemoryResponse } from "@memory.build/client";
import { useShallow } from "zustand/shallow";
import { useMemory, useTree } from "./api/queries.ts";
import { DeleteMemoryDialog } from "./components/dialogs/DeleteMemoryDialog.tsx";
import { DeleteTreeDialog } from "./components/dialogs/DeleteTreeDialog.tsx";
import { EditorPane } from "./components/editor/EditorPane.tsx";
import { SidebarResizer } from "./components/layout/SidebarResizer.tsx";
import { AdvancedSearchSection } from "./components/search/AdvancedSearchSection.tsx";
import { SimpleSearchBar } from "./components/search/SimpleSearchBar.tsx";
import { ToastStack } from "./components/toast/Toast.tsx";
import { ContextMenu } from "./components/tree/ContextMenu.tsx";
import { TreeView } from "./components/tree/TreeView.tsx";
import { MetadataPanel } from "./components/viewer/MetadataPanel.tsx";
import { useUrlSync } from "./lib/useUrlSync.ts";
import { useFilter } from "./store/filter.ts";
import { useLayout } from "./store/layout.ts";
import { useSelection } from "./store/selection.ts";
import { useUi } from "./store/ui.ts";

export function App() {
  useUrlSync();

  const filterMode = useFilter(useShallow((s) => s.mode));

  const tree = useTree();
  const selectedId = useSelection((s) => s.selectedId);
  const { data: selectedMemory } = useMemory(selectedId);
  const sidebarWidth = useLayout((s) => s.sidebarWidth);

  const totalMemories = tree.data
    ? sumTopLevelAggregate(tree.data.nodes)
    : null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-900">
            Memory Engine
          </h1>
          <p className="text-xs text-slate-500">
            {totalMemories === null
              ? "Loading…"
              : `${totalMemories} ${totalMemories === 1 ? "memory" : "memories"}`}
            {tree.isFetching && totalMemories !== null ? " · refreshing…" : ""}
          </p>
        </div>
        {filterMode === "simple" ? (
          <SimpleSearchBar />
        ) : (
          <AdvancedSearchSection />
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="shrink-0 overflow-auto border-r border-slate-200 bg-white"
          style={{ width: sidebarWidth }}
        >
          <TreeView />
        </aside>
        <SidebarResizer />

        <main className="min-w-0 flex-1 overflow-auto bg-slate-50">
          {selectedMemory ? (
            <SelectedMemoryPane memory={selectedMemory} />
          ) : (
            <EmptyPane selectedId={selectedId} />
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

function EmptyPane({ selectedId }: { selectedId: string | null }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-slate-500">
        {selectedId
          ? "Loading memory…"
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
