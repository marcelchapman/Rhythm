import { useEffect, useRef, useState } from "react";
import {
  emptySelection,
  retainSelection,
  selectTrack,
  contextSelection,
} from "./track-selection";

/** Every track-list presentation uses the same ID/anchor/focus transitions. */
export function useTrackSelection(order: string[], scope?: string) {
  const [selection, setSelection] = useState(emptySelection);
  const previousScope = useRef(scope);
  useEffect(() => {
    const changed = previousScope.current !== scope;
    previousScope.current = scope;
    setSelection((previous) =>
      changed ? emptySelection() : retainSelection(previous, order),
    );
  }, [order, scope]);
  return {
    selection,
    choose(id: string, extend = false, toggle = false) {
      setSelection((previous) =>
        selectTrack(previous, order, id, extend, toggle),
      );
    },
    context(id: string) {
      const next = contextSelection(selection, order, id);
      setSelection(next);
      return order.filter((id) => next.ids.has(id));
    },
    dragIds(id: string) {
      return selection.ids.has(id)
        ? order.filter((id) => selection.ids.has(id))
        : [id];
    },
  };
}
