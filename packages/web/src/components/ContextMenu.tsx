/**
 * Floating context menu for the tree view.
 *
 * Renders at the cursor position passed via `useUi`. Closes on any click
 * outside the menu or on Escape. Items are target-kind specific: memory
 * leaves show "Delete…", path nodes show "Delete subtree…".
 */
import { useEffect, useRef } from "react";
import { useUi } from "../store/ui.ts";

export function ContextMenu() {
  const state = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeContextMenu);
  const askDeleteMemory = useUi((s) => s.askDeleteMemory);
  const askDeleteTree = useUi((s) => s.askDeleteTree);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, close]);

  if (!state) return null;

  const items =
    state.target.kind === "memory"
      ? [
          {
            label: "Delete…",
            onClick: () =>
              askDeleteMemory({
                id: (
                  state.target as { kind: "memory"; id: string; title: string }
                ).id,
                title: (
                  state.target as { kind: "memory"; id: string; title: string }
                ).title,
              }),
            danger: true,
          },
        ]
      : [
          {
            label: "Delete subtree…",
            onClick: () =>
              askDeleteTree(
                (state.target as { kind: "path"; path: string }).path,
              ),
            danger: true,
          },
        ];

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[12rem] rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
      style={{ top: state.y, left: state.x }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={item.onClick}
          className={[
            "block w-full px-3 py-1.5 text-left",
            item.danger
              ? "text-red-700 hover:bg-red-50"
              : "text-slate-700 hover:bg-slate-100",
          ].join(" ")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
