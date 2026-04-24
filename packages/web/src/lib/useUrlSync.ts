/**
 * `useUrlSync` — keeps filter + selection state in sync with the URL.
 *
 * Lifecycle:
 * - On mount, hydrate both stores from the current URL.
 * - On every state change, `replaceState` the updated URL.
 * - On `popstate` (back/forward), re-hydrate from the URL.
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useFilter } from "../store/filter.ts";
import { useSelection } from "../store/selection.ts";
import { decodeUrlState, replaceUrlState } from "./url-state.ts";

export function useUrlSync(): void {
  // Initial hydration. We read `window.location` once, push into the stores,
  // and rely on the effect below to keep pushing updates back out. The URL
  // writer is gated until this completes; otherwise the first render's empty
  // default stores can replace `?selected=...` before hydration has a chance
  // to select the linked memory.
  const [hasHydratedUrlState, setHasHydratedUrlState] = useState(false);

  useEffect(() => {
    const decoded = decodeUrlState(window.location.search);
    useFilter.getState().hydrate(decoded.filter);
    useSelection.getState().select(decoded.selectedId);
    setHasHydratedUrlState(true);

    const onPop = () => {
      const next = decodeUrlState(window.location.search);
      useFilter.getState().hydrate(next.filter);
      useSelection.getState().select(next.selectedId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const filter = useFilter(
    useShallow((s) => ({
      mode: s.mode,
      simple: s.simple,
      advanced: s.advanced,
    })),
  );
  const selectedId = useSelection((s) => s.selectedId);

  useEffect(() => {
    if (!hasHydratedUrlState) return;
    replaceUrlState(filter, selectedId);
  }, [filter, hasHydratedUrlState, selectedId]);
}
