import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Track } from "../shared/types";
import type { TrackColumnId } from "../shared/preferences";
import {
  metadataDraft,
  numericMaximum,
  type MetadataDraft,
} from "../shared/metadata-editor";
import {
  inlineCandidate,
  inlineDestinations,
  inlineFields,
  inlinePatch,
  type InlineCell,
  type InlineColumn,
} from "./inline-metadata";
import { sameInlineCell, type InlineSaveController } from "./inline-save";

interface Edit extends InlineCell {
  session: string;
  before: MetadataDraft;
  value: string;
  phase: "checking" | "editing" | "waiting";
  direction?: 1 | -1;
}
export function useInlineMetadata(options: {
  session?: string;
  tracks: Track[];
  columns: TrackColumnId[];
  viewport: RefObject<HTMLDivElement | null>;
  save?: InlineSaveController;
  select: (track: Track) => void;
}) {
  const [edit, setEditState] = useState<Edit | null>(null);
  const [message, setMessage] = useState("");
  const [invalid, setInvalid] = useState(false);
  const active = useRef(edit),
    env = useRef(options);
  env.current = options;
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const focusRequested = useRef(false);
  const focusId = useRef<string | null>(null);
  const save = options.session ? (options.save?.status ?? null) : null;
  const checking = useRef(false);
  const setEdit = (next: Edit | null) => {
    active.current = next;
    setEditState(next);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const finish = (id: string, restoreFocus = true) => {
    focusRequested.current = restoreFocus;
    focusId.current = restoreFocus ? id : null;
    setEdit(null);
    setMessage("");
    setInvalid(false);
  };
  useEffect(() => {
    if (active.current && active.current.session !== options.session)
      finish(active.current.id, false);
  }, [options.session]);
  useLayoutEffect(() => {
    const id = edit?.id ?? focusId.current;
    if (
      !id ||
      (!focusRequested.current && document.activeElement !== input.current)
    )
      return;
    const index = options.tracks.findIndex((t) => t.id === id),
      el = options.viewport.current;
    if (index >= 0 && el) {
      if (index * 34 < el.scrollTop) el.scrollTop = index * 34;
      else if ((index + 2) * 34 > el.scrollTop + el.clientHeight)
        el.scrollTop = (index + 2) * 34 - el.clientHeight;
    }
    if (!focusRequested.current) return;
    focusRequested.current = false;
    if (edit) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
      input.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      options.viewport.current?.focus({ preventScroll: true });
      focusId.current = null;
    }
  }, [edit?.id, edit?.column, edit?.phase, options.tracks]);
  const current = (e: Edit) =>
    alive.current && active.current === e && env.current.session === e.session;
  const makeEdit = (
    track: Track,
    column: InlineColumn,
    session: string,
    direction?: 1 | -1,
  ): Edit => {
    const before = metadataDraft(track);
    const slot = env.current.save?.current();
    return {
      id: track.id,
      column,
      session,
      before,
      direction,
      value: before[inlineFields[column]],
      phase:
        slot &&
        (slot.phase === "pending" ||
          slot.draft.session !== session ||
          !sameInlineCell(slot.draft, { id: track.id, column }))
          ? "waiting"
          : "checking",
    };
  };
  const focus = (next: Edit, track: Track) => {
    env.current.select(track);
    focusRequested.current = true;
    setMessage("");
    setInvalid(false);
    setEdit(next);
  };
  const candidates = (e: Edit, direction: 1 | -1, skipTrack = false) =>
    inlineDestinations(
      env.current.tracks,
      env.current.columns,
      e,
      direction,
      skipTrack,
    );
  const check = async (next: Edit) => {
    if (checking.current) return;
    checking.current = true;
    try {
      const result = await window.rio.metadataEligibility(
        next.id,
        next.session,
      );
      if (!current(next)) return;
      if (!result.editable) {
        // Provisional navigation is based on the table. Once main can answer,
        // skip a refused track in the direction the user was moving.
        if (next.direction) {
          const target = candidates(next, next.direction, true).next().value;
          const track = env.current.tracks.find((t) => t.id === target?.id);
          if (target && track) {
            const following = makeEdit(
              track,
              target.column,
              next.session,
              next.direction,
            );
            focus(following, track);
            if (following.phase === "checking") void check(following);
            return;
          }
        }
        finish(next.id);
        setMessage(result.message || "This track is read only.");
        return;
      }
      const slot = env.current.save?.current();
      setEdit({
        ...next,
        phase: "editing",
        value:
          slot?.phase === "failed" &&
          slot.draft.session === next.session &&
          sameInlineCell(slot.draft, next)
            ? slot.draft.value
            : next.value,
      });
    } catch {
      if (current(next)) {
        finish(next.id);
        setMessage("Rio couldn’t verify editing eligibility. Try again.");
      }
    } finally {
      checking.current = false;
      const latest = active.current;
      if (
        latest &&
        latest !== next &&
        latest.phase === "checking" &&
        current(latest)
      )
        void check(latest);
    }
  };
  const begin = (track: Track, column: InlineColumn) => {
    const { session } = env.current;
    if (!session || active.current || !inlineCandidate(track)) return;
    const next = makeEdit(track, column, session);
    focus(next, track);
    if (next.phase === "checking") void check(next);
  };
  const navigate = (e: Edit, direction: 1 | -1) => {
    const target = candidates(e, direction).next().value;
    const track = env.current.tracks.find((t) => t.id === target?.id);
    if (!target || !track) {
      finish(e.id);
      return;
    }
    const next = makeEdit(track, target.column, e.session, direction);
    focus(next, track);
    if (next.phase === "checking") void check(next);
  };
  useEffect(() => {
    const e = active.current;
    if (!e || e.session !== options.session || save?.phase === "pending")
      return;
    if (e.phase === "waiting" && !save) {
      const track = env.current.tracks.find((t) => t.id === e.id);
      if (
        !track ||
        !inlineCandidate(track) ||
        !env.current.columns.includes(e.column)
      ) {
        finish(e.id, false);
        return;
      }
      const next = makeEdit(track, e.column, e.session, e.direction);
      setEdit(next);
      void check(next);
    }
  }, [save, options.session]);
  const commit = (direction?: 1 | -1, restoreFocus = true) => {
    const e = active.current;
    const controller = env.current.save;
    if (!e || !controller) return;
    if (e.phase === "waiting" || (e.phase !== "editing" && direction)) {
      if (direction) navigate(e, direction);
      return;
    }
    if (e.phase !== "editing") return;
    const slot = controller.current();
    if (
      slot?.phase === "pending" ||
      (slot &&
        (slot.draft.session !== e.session || !sameInlineCell(slot.draft, e)))
    )
      return;
    const started =
      window.rio.metadataTimingEnabled ||
      sessionStorage.getItem("rio:metadata-timing") === "1"
        ? performance.now()
        : undefined;
    let patch;
    try {
      patch = inlinePatch(e.before, e.column, e.value);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setInvalid(true);
      input.current?.focus();
      return;
    }
    if (!Object.keys(patch).length) {
      controller.discard(e);
      if (direction) navigate(e, direction);
      else finish(e.id, restoreFocus);
      return;
    }
    setMessage("");
    setInvalid(false);
    void controller.submit(
      { id: e.id, column: e.column, session: e.session, value: e.value },
      patch,
      started,
    );
    if (direction) navigate(e, direction);
    else finish(e.id, restoreFocus);
  };
  const review = () => {
    if (save?.phase !== "failed" || save.draft.session !== options.session)
      return;
    if (
      active.current?.phase === "editing" &&
      sameInlineCell(active.current, save.draft)
    ) {
      input.current?.focus();
      return;
    }
    const track = options.tracks.find((t) => t.id === save.draft.id);
    if (
      !track ||
      !options.columns.includes(save.draft.column) ||
      !inlineCandidate(track)
    )
      return;
    const next = makeEdit(track, save.draft.column, save.draft.session);
    focus(next, track);
    void check(next);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    let consumeClick = false,
      consumeDoubleClick = false;
    const outside = (event: PointerEvent) => {
      consumeClick = false;
      const e = active.current;
      if (
        !e ||
        event.composedPath().includes(input.current!) ||
        (event.target instanceof Element &&
          event.target.closest("#inline-metadata-status"))
      )
        return;
      if (e.phase === "waiting") return;
      // A commit gesture must not activate a row under a shifting table.
      event.preventDefault();
      event.stopImmediatePropagation();
      consumeClick = true;
      consumeDoubleClick = true;
      void commitRef.current();
    };
    const click = (event: MouseEvent) => {
      if (!consumeClick && !(consumeDoubleClick && event.detail > 1)) {
        if (event.detail === 1) consumeDoubleClick = false;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      consumeClick = false;
    };
    const doubleClick = (event: MouseEvent) => {
      if (!consumeDoubleClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      consumeDoubleClick = false;
    };
    const blur = () => {
      commitRef.current(undefined, false);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("click", click, true);
    window.addEventListener("dblclick", doubleClick, true);
    window.addEventListener("contextmenu", click, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("dblclick", doubleClick, true);
      window.removeEventListener("contextmenu", click, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return {
    edit,
    begin,
    message,
    invalid,
    save,
    review,
    discard: () => {
      if (save?.phase !== "failed") return;
      if (
        active.current &&
        active.current.session === save.draft.session &&
        sameInlineCell(active.current, save.draft)
      )
        finish(save.draft.id);
      options.save?.discard(save.draft);
    },
    canReview:
      save?.phase === "failed" &&
      save.draft.session === options.session &&
      options.columns.includes(save.draft.column) &&
      options.tracks.some((t) => t.id === save.draft.id && inlineCandidate(t)),
    input: edit ? (
      <input
        ref={input}
        className="inline-metadata-input"
        aria-label={`Edit ${edit.column === "track" ? "Track number" : edit.column === "disc" ? "Disc number" : edit.column === "bpm" ? "BPM" : edit.column[0].toUpperCase() + edit.column.slice(1)}`}
        aria-describedby="inline-metadata-status"
        aria-invalid={invalid}
        aria-busy={
          edit.phase !== "editing" &&
          !(edit.phase === "waiting" && save?.phase === "failed")
        }
        inputMode={
          numericMaximum(inlineFields[edit.column]) === null
            ? "text"
            : "numeric"
        }
        readOnly={edit.phase !== "editing"}
        maxLength={
          numericMaximum(inlineFields[edit.column]) === null ? 4000 : 6
        }
        value={
          edit.phase === "waiting" &&
          save &&
          save.draft.session === edit.session &&
          sameInlineCell(save.draft, edit)
            ? save.draft.value
            : edit.value
        }
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onChange={(event) => {
          if (active.current?.phase === "editing") {
            setEdit({ ...active.current, value: event.target.value });
            setMessage("");
            setInvalid(false);
          }
        }}
        onBlur={(event) => {
          if (active.current !== edit) return;
          if (edit.phase === "waiting" || edit.phase === "checking") {
            finish(edit.id, false);
            return;
          }
          if (
            event.relatedTarget instanceof Element &&
            event.relatedTarget.closest("#inline-metadata-status")
          )
            return;
          commitRef.current(undefined, false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (["Enter", "Escape", "Tab"].includes(event.key))
            event.preventDefault();
          if (event.key === "Escape") {
            if (edit.phase === "editing") options.save?.discard(edit);
            finish(edit.id);
          } else if (event.key === "Enter") commit();
          else if (event.key === "Tab") commit(event.shiftKey ? -1 : 1);
        }}
      />
    ) : null,
  };
}
