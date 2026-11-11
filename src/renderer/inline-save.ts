import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { MetadataEditPatch } from "../shared/metadata-editor";
import type { Snapshot, Track } from "../shared/types";
import type { InlineCell } from "./inline-metadata";

export interface InlineDraft extends InlineCell {
  session: string;
  value: string;
}
type Save =
  | { draft: InlineDraft; phase: "pending" }
  | { draft: InlineDraft; phase: "failed"; message: string };

const metadataKeys = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "albumId",
  "composer",
  "genre",
  "year",
  "track",
  "trackTotal",
  "disc",
  "discTotal",
  "bpm",
  "comments",
  "duration",
  "fileSize",
  "bitRate",
  "codec",
  "hasArtwork",
] as const satisfies readonly (keyof Track)[];

// An inline reply is authoritative for this edit, not for newer catalog/UI work.
export function applyInlineSave(
  current: Snapshot | null,
  before: Track | undefined,
  reply: Snapshot,
) {
  if (!current || !before || current.metadataSession !== reply.metadataSession)
    return current;
  const updated = reply.tracks.find((track) => track.id === before.id);
  const existing = current.tracks.find((track) => track.id === before.id);
  if (
    !updated ||
    !existing ||
    updated.path !== before.path ||
    existing.path !== before.path ||
    existing.mediaRootId !== before.mediaRootId ||
    metadataKeys.some((key) => existing[key] !== before[key])
  )
    return current;
  const metadata = Object.fromEntries(
    metadataKeys.map((key) => [key, updated[key]]),
  );
  return {
    ...current,
    tracks: current.tracks.map((track) =>
      track === existing ? { ...track, ...metadata } : track,
    ),
  };
}
export function sameInlineCell(a: InlineCell, b: InlineCell) {
  return a.id === b.id && a.column === b.column;
}
export function useInlineSave(
  data: RefObject<Snapshot | null>,
  setData: Dispatch<SetStateAction<Snapshot | null>>,
) {
  const [status, setStatus] = useState<Save | null>(null);
  const active = useRef<Save | null>(null);
  const current = () => active.current;
  const set = (next: Save | null) => {
    active.current = next;
    setStatus(next);
  };
  const submit = async (
    draft: InlineDraft,
    patch: MetadataEditPatch,
    started?: number,
  ) => {
    const slot = current();
    if (
      draft.session !== data.current?.metadataSession ||
      slot?.phase === "pending" ||
      (slot &&
        (slot.draft.session !== draft.session ||
          !sameInlineCell(slot.draft, draft)))
    )
      return;
    const before = data.current.tracks.find((track) => track.id === draft.id);
    const pending = { draft, phase: "pending" as const };
    set(pending);
    let message: string;
    try {
      const sent = started === undefined ? undefined : performance.now();
      const result = await window.rio.editTrackMetadata(
        draft.id,
        draft.session,
        patch,
      );
      if (started !== undefined && sent !== undefined) {
        const reply = performance.now();
        requestAnimationFrame(() => {
          console.info(
            "RIO_METADATA_RENDERER",
            JSON.stringify({
              surface: "inline",
              wallMs: performance.now() - started,
              eventToIpcMs: sent - started,
              ipcMs: reply - sent,
              replyToFrameMs: performance.now() - reply,
              ok: result.ok,
            }),
          );
        });
      }
      if (current() !== pending) return;
      if (result.ok && result.snapshot.metadataSession === draft.session) {
        setData((previous) =>
          applyInlineSave(previous, before, result.snapshot),
        );
        set(null);
        return;
      }
      message = result.ok
        ? "The library changed during Save."
        : result.message +
          (result.diagnosticId ? ` (Reference: ${result.diagnosticId}.)` : "");
    } catch (error) {
      console.error("Inline metadata save failed:", error);
      message = "Rio couldn’t save this change. Check the file and try again.";
    }
    if (current() === pending) set({ draft, phase: "failed", message });
  };
  const discard = (cell: Omit<InlineDraft, "value">) => {
    const slot = current();
    if (
      slot?.phase === "failed" &&
      slot.draft.session === cell.session &&
      sameInlineCell(slot.draft, cell)
    )
      set(null);
  };
  return { status, current, submit, discard };
}
export type InlineSaveController = ReturnType<typeof useInlineSave>;
