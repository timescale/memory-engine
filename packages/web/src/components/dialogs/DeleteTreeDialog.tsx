/**
 * Subtree delete confirmation.
 *
 * On open, calls `memory.deleteTree` with `dryRun: true` to fetch the exact
 * count, then renders a confirmation with the number of memories that will
 * be removed. On confirm, re-issues the call with `dryRun: false`.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "../../api/client.ts";
import { useDeleteTree } from "../../api/queries.ts";
import type { MemoryDeleteTreeResult } from "../../api/types.ts";
import { useSelection } from "../../store/selection.ts";
import { useUi } from "../../store/ui.ts";
import { pushToast } from "../toast/Toast.tsx";
import { Dialog } from "./Dialog.tsx";

export function DeleteTreeDialog() {
  const treePath = useUi((s) => s.deleteTreePath);
  const close = useUi((s) => s.closeDialogs);
  const select = useSelection((s) => s.select);

  const queryClient = useQueryClient();
  const del = useDeleteTree(queryClient);

  // Dry-run count. Disabled until the dialog is actually open.
  const { data, isLoading, error } = useQuery({
    enabled: treePath !== null,
    queryKey: ["deleteTreeDryRun", treePath],
    queryFn: () =>
      rpc<MemoryDeleteTreeResult>("memory.deleteTree", {
        tree: treePath as string,
        dryRun: true,
      }),
  });

  const handleConfirm = async () => {
    if (!treePath) return;
    try {
      const result = await del.mutateAsync({ tree: treePath, dryRun: false });
      // Selection may be orphaned after a bulk delete; clear it to be safe.
      select(null);
      queryClient.invalidateQueries({ queryKey: ["deleteTreeDryRun"] });
      pushToast(
        `Deleted ${result.count} memor${result.count === 1 ? "y" : "ies"}`,
        "success",
      );
      close();
    } catch {
      /* error surfaced below */
    }
  };

  return (
    <Dialog
      open={treePath !== null}
      onClose={close}
      title={
        <span>
          Delete subtree{" "}
          <code className="font-mono text-xs text-slate-600">{treePath}</code>?
        </span>
      }
      footer={
        <>
          <button
            type="button"
            onClick={close}
            disabled={del.isPending}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={del.isPending || isLoading || !data || data.count === 0}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {del.isPending
              ? "Deleting…"
              : data
                ? `Delete ${data.count} memor${data.count === 1 ? "y" : "ies"}`
                : "Delete"}
          </button>
        </>
      }
    >
      {isLoading && <p>Counting affected memories…</p>}
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      {data &&
        (data.count === 0 ? (
          <p>No memories live under this path.</p>
        ) : (
          <p>
            This will delete{" "}
            <strong className="text-slate-900">{data.count}</strong>{" "}
            {data.count === 1 ? "memory" : "memories"} under{" "}
            <code className="font-mono text-xs">{treePath}</code> and its
            subpaths. This cannot be undone.
          </p>
        ))}
      {del.error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {del.error.message}
        </p>
      )}
    </Dialog>
  );
}
