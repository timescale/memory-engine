/**
 * Single-memory delete confirmation.
 *
 * Reads the memory to delete from `useUi.deleteMemory`. On confirm, calls
 * `memory.delete`, clears the selection if the deleted memory was selected,
 * and closes the dialog.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useDeleteMemory } from "../../api/queries.ts";
import { useSelection } from "../../store/selection.ts";
import { useUi } from "../../store/ui.ts";
import { pushToast } from "../toast/Toast.tsx";
import { Dialog } from "./Dialog.tsx";

export function DeleteMemoryDialog() {
  const target = useUi((s) => s.deleteMemory);
  const close = useUi((s) => s.closeDialogs);
  const select = useSelection((s) => s.select);
  const selectedId = useSelection((s) => s.selectedId);

  const queryClient = useQueryClient();
  const del = useDeleteMemory(queryClient);

  const handleConfirm = async () => {
    if (!target) return;
    try {
      await del.mutateAsync(target.id);
      if (selectedId === target.id) select(null);
      pushToast("Memory deleted", "success");
      close();
    } catch {
      // Error is exposed in the dialog body; keep the dialog open so the
      // user can read the message and retry.
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title="Delete this memory?"
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
            disabled={del.isPending}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:bg-slate-300"
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      {target && (
        <>
          <p className="font-medium text-slate-900">{target.title}</p>
          <p className="mt-1 font-mono text-xs text-slate-500">{target.id}</p>
          <p className="mt-3 text-slate-600">
            This cannot be undone. Any grants referencing this memory will be
            removed automatically.
          </p>
          {del.error && (
            <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {del.error.message}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
