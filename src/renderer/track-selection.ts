/** One selection model shared by pointer, keyboard and contextual track actions. */
export interface TrackSelection {
  ids: Set<string>;
  anchor: string | null;
  focus: string | null;
}
export const emptySelection = (): TrackSelection => ({
  ids: new Set(),
  anchor: null,
  focus: null,
});
export function retainSelection(
  selection: TrackSelection,
  order: string[],
): TrackSelection {
  const available = new Set(order);
  const ids = new Set([...selection.ids].filter((id) => available.has(id)));
  const focus =
    selection.focus && available.has(selection.focus)
      ? selection.focus
      : ([...ids][0] ?? null);
  const anchor =
    selection.anchor && available.has(selection.anchor)
      ? selection.anchor
      : focus;
  return ids.size === selection.ids.size &&
    anchor === selection.anchor &&
    focus === selection.focus
    ? selection
    : { ids, anchor, focus };
}
export function selectTrack(
  selection: TrackSelection,
  order: string[],
  id: string,
  extend = false,
  toggle = false,
): TrackSelection {
  if (!order.includes(id)) return selection;
  const anchor =
    selection.anchor && order.includes(selection.anchor)
      ? selection.anchor
      : id;
  if (extend) {
    const from = order.indexOf(anchor),
      to = order.indexOf(id);
    return {
      ids: new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)),
      anchor,
      focus: id,
    };
  }
  const ids = toggle ? new Set(selection.ids) : new Set<string>();
  if (toggle && ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id, focus: id };
}
export function contextSelection(
  selection: TrackSelection,
  order: string[],
  id: string,
): TrackSelection {
  return selection.ids.has(id)
    ? { ...selection, focus: id }
    : selectTrack(selection, order, id);
}
/** OS convention belongs at the UI boundary, never in library/domain operations. */
export function selectionModifier(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform: string,
): boolean {
  return /Mac/i.test(platform) ? event.metaKey : event.ctrlKey;
}
