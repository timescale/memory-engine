import type { PathNode } from "../lib/tree-build.ts";
import type { TreeContext } from "../store/selection.ts";
import { PathRow } from "./PathRow.tsx";

export function TreeContent({
  activeError,
  activeLoading,
  context,
  roots,
  searchActive,
}: {
  activeError: unknown;
  activeLoading: boolean;
  context: TreeContext;
  roots: PathNode[];
  searchActive: boolean;
}) {
  if (activeError) {
    return (
      <div className="p-4 text-sm text-red-700">
        <p className="font-medium">
          {searchActive ? "Search failed" : "Failed to load tree"}
        </p>
        <p className="mt-1 text-xs text-red-600">
          {activeError instanceof Error
            ? activeError.message
            : String(activeError)}
        </p>
      </div>
    );
  }

  if (activeLoading) {
    return (
      <div className="p-4 text-sm text-slate-500">
        {searchActive ? "Searching…" : "Loading tree…"}
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        {searchActive
          ? "No memories match the current filter."
          : "No memories yet. Create one from the CLI or MCP server to see it here."}
      </div>
    );
  }

  return (
    <div className="py-1" role="tree" aria-label="Memories">
      {roots.map((node) => (
        <PathRow key={node.path} node={node} context={context} />
      ))}
    </div>
  );
}
