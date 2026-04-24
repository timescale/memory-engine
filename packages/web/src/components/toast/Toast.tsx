/**
 * Lightweight toast notifications.
 *
 * `pushToast(message, kind)` from anywhere in the app pushes a new toast;
 * `<ToastStack />` (rendered once near the root) displays them with auto
 * dismissal. No router / portal indirection — a single zustand store keeps
 * the code tiny.
 */
import { useEffect } from "react";
import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastState {
  toasts: Toast[];
  push(message: string, kind?: ToastKind, ttlMs?: number): void;
  dismiss(id: number): void;
}

let nextId = 1;

const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push(message, kind = "info", ttlMs = 3000) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    if (ttlMs > 0) {
      setTimeout(() => get().dismiss(id), ttlMs);
    }
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/**
 * Push a toast from anywhere in the app.
 */
export function pushToast(
  message: string,
  kind: ToastKind = "info",
  ttlMs = 3000,
): void {
  useToastStore.getState().push(message, kind, ttlMs);
}

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    // No-op — here so the subscription reliably re-renders on push.
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={[
            "pointer-events-auto cursor-pointer rounded-md border px-4 py-3 text-left text-sm shadow-md transition-opacity",
            t.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : t.kind === "error"
                ? "border-red-200 bg-red-50 text-red-900"
                : "border-slate-200 bg-white text-slate-800",
          ].join(" ")}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
