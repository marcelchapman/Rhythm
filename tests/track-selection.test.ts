import { expect, test } from "vitest";
import {
  emptySelection,
  selectTrack,
  contextSelection,
  retainSelection,
  selectionModifier,
} from "../src/renderer/track-selection";
const order = ["a", "b", "c", "d", "e"];
test("normal click replaces selection; primary click toggles and establishes anchor", () => {
  let s = selectTrack(emptySelection(), order, "b");
  s = selectTrack(s, order, "d", false, true);
  expect([...s.ids]).toEqual(["b", "d"]);
  s = selectTrack(s, order, "b", false, true);
  expect([...s.ids]).toEqual(["d"]);
  s = selectTrack(s, order, "a");
  expect([...s.ids]).toEqual(["a"]);
  expect(s.anchor).toBe("a");
});
test("range grows and contracts using a stable anchor and moving keyboard focus", () => {
  let s = selectTrack(emptySelection(), order, "c");
  s = selectTrack(s, order, "d", true);
  expect([...s.ids]).toEqual(["c", "d"]);
  s = selectTrack(s, order, "e", true);
  expect([...s.ids]).toEqual(["c", "d", "e"]);
  s = selectTrack(s, order, "b", true);
  expect([...s.ids]).toEqual(["b", "c"]);
  expect(s).toMatchObject({ anchor: "c", focus: "b" });
});
test("right click preserves selected group and targets clicked row; unselected click resets anchor", () => {
  let s = selectTrack(emptySelection(), order, "b");
  s = selectTrack(s, order, "d", true);
  s = contextSelection(s, order, "c");
  expect([...s.ids]).toEqual(["b", "c", "d"]);
  expect(s).toMatchObject({ anchor: "b", focus: "c" });
  s = contextSelection(s, order, "e");
  expect([...s.ids]).toEqual(["e"]);
  expect([...selectTrack(s, order, "c", true).ids]).toEqual(["c", "d", "e"]);
});
test("sorting keeps anchor identity and ranges follow displayed order; removal prunes without selecting neighbours", () => {
  let s = selectTrack(emptySelection(), order, "b");
  const sorted = ["e", "d", "c", "b", "a"];
  s = retainSelection(s, sorted);
  expect([...selectTrack(s, sorted, "d", true).ids]).toEqual(["d", "c", "b"]);
  s = selectTrack(s, order, "d", false, true);
  s = retainSelection(s, ["a", "d", "e"]);
  expect([...s.ids]).toEqual(["d"]);
  expect(s.anchor).toBe("d");
  expect(retainSelection(s, []).ids.size).toBe(0);
});
test("missing/empty anchor starts range at clicked row; invalid targets do nothing", () => {
  const s = emptySelection();
  expect([...selectTrack(s, order, "c", true).ids]).toEqual(["c"]);
  expect(selectTrack(s, order, "absent")).toBe(s);
});
test("primary modifier follows OS convention at UI boundary", () => {
  expect(selectionModifier({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(
    true,
  );
  expect(selectionModifier({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(
    false,
  );
  expect(
    selectionModifier({ metaKey: true, ctrlKey: false }, "Linux x86_64"),
  ).toBe(false);
  expect(
    selectionModifier({ metaKey: false, ctrlKey: true }, "Linux x86_64"),
  ).toBe(true);
  expect(selectionModifier({ metaKey: false, ctrlKey: true }, "Win32")).toBe(
    true,
  );
});
