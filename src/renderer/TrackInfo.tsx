import { useEffect, useRef, useState } from "react";
import type { Snapshot, Track } from "../shared/types";
import {
  metadataFields,
  metadataDraft,
  metadataChanges,
  numericMaximum,
} from "../shared/metadata-editor";

export function TrackInfo({
  track,
  session,
  close,
  saved,
  savingChanged,
}: {
  track: Track;
  session: string;
  close: () => void;
  saved: (snapshot: Snapshot) => void;
  savingChanged: (busy: boolean) => void;
}) {
  const initial = useRef(metadataDraft(track));
  const [draft, setDraft] = useState(initial.current);
  const [eligibility, setEligibility] = useState<{
    editable: boolean;
    message?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    let active = true;
    void window.rio.metadataEligibility(track.id, session).then(
      (result) => {
        if (active) setEligibility(result);
      },
      (error) => {
        console.error("Metadata eligibility failed:", error);
        if (active)
          setEligibility({
            editable: false,
            message:
              "Rio couldn’t verify editing eligibility. Reopen Track Info to try again.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [track.id, session]);
  const changed = metadataFields.some(
    ([key]) => initial.current[key] !== draft[key],
  );
  const technical = [
    [
      "Duration",
      `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, "0")}`,
    ],
    ["Format", track.format.toUpperCase()],
    ["Codec", track.codec || "—"],
    [
      "Bit rate",
      track.bitRate ? `${Math.round(track.bitRate / 1000)} kbps` : "—",
    ],
    [
      "Ownership",
      track.locationKind === "managed"
        ? "Managed copy in Rio Media"
        : "Referenced file",
    ],
    [
      "Availability",
      track.missing
        ? "Unavailable · use Locate File to reconnect"
        : "Available",
    ],
    ["File location", track.path],
  ];
  return (
    <form
      aria-busy={saving}
      onSubmit={async (event) => {
        event.preventDefault();
        if (savingRef.current || !eligibility?.editable || !changed) return;
        setError("");
        let patch;
        try {
          patch = metadataChanges(initial.current, draft);
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          return;
        }
        savingRef.current = true;
        setSaving(true);
        savingChanged(true);
        try {
          const result = await window.rio.editTrackMetadata(
            track.id,
            session,
            patch,
          );
          if (!result.ok) {
            setError(
              result.message +
                (result.diagnosticId
                  ? ` (Reference: ${result.diagnosticId}.)`
                  : ""),
            );
            return;
          }
          saved(result.snapshot);
        } catch (error) {
          console.error("Metadata save failed:", error);
          setError(
            "Rio couldn’t complete this metadata edit. Reopen Track Info and try again.",
          );
        } finally {
          savingRef.current = false;
          setSaving(false);
          savingChanged(false);
        }
      }}
    >
      <p className="muted" role="status">
        {!eligibility
          ? "Checking whether this track can be edited…"
          : eligibility.editable
            ? "Edit this managed copy. Its file location stays the same."
            : eligibility.message}
      </p>
      {error && (
        <p className="media-error" role="alert">
          {error}
        </p>
      )}
      <dl className="track-info-fields">
        {metadataFields.map(([key, label]) => (
          <div key={key}>
            <dt>
              {eligibility?.editable ? (
                <label htmlFor={`metadata-${key}`}>{label}</label>
              ) : (
                label
              )}
            </dt>
            <dd>
              {eligibility?.editable ? (
                key === "comments" ? (
                  <textarea
                    id={`metadata-${key}`}
                    rows={3}
                    maxLength={4000}
                    disabled={saving}
                    value={draft[key]}
                    onChange={(e) =>
                      setDraft({ ...draft, [key]: e.target.value })
                    }
                  />
                ) : (
                  <input
                    id={`metadata-${key}`}
                    type="text"
                    inputMode={
                      numericMaximum(key) === null ? "text" : "numeric"
                    }
                    maxLength={numericMaximum(key) === null ? 4000 : 6}
                    disabled={saving}
                    value={draft[key]}
                    onChange={(e) =>
                      setDraft({ ...draft, [key]: e.target.value })
                    }
                  />
                )
              ) : (
                initial.current[key] || "—"
              )}
            </dd>
          </div>
        ))}
        {technical.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="dialog-actions">
        <button
          type="button"
          className="quiet"
          disabled={saving}
          onClick={close}
        >
          {eligibility?.editable ? "Cancel" : "Done"}
        </button>
        {eligibility?.editable && (
          <button
            className="primary"
            type="submit"
            disabled={saving || !changed}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </form>
  );
}
