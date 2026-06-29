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
            className="rounded-md border border-ink/[0.18] bg-white px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={del.isPending}
            className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      {target && (
        <>
          <p className="font-medium text-ink">{target.title}</p>
          <p className="mt-1 font-mono text-[11px] text-ink/50">{target.id}</p>
          <p className="mt-3 text-ink/70">
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
