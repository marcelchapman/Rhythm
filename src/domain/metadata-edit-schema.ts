import type { DatabaseSync } from "node:sqlite";
export function migrateMetadataEdits(db: DatabaseSync) {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE tracks ADD COLUMN composer TEXT NOT NULL DEFAULT '';
    ALTER TABLE tracks ADD COLUMN trackTotal INTEGER;
    ALTER TABLE tracks ADD COLUMN discTotal INTEGER;
    CREATE TABLE managed_file_receipts (
      trackId TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      rootId TEXT NOT NULL REFERENCES media_roots(id), relative TEXT NOT NULL,
      digest TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL);
    INSERT INTO managed_file_receipts
      SELECT l.trackId,l.mediaRootId,l.relativePath,j.digest,j.stageDevice,j.stageInode
      FROM track_locations l JOIN managed_imports j ON j.rowid=(
        SELECT MAX(x.rowid) FROM managed_imports x WHERE x.trackId=l.trackId AND x.rootId=l.mediaRootId AND x.relative=l.relativePath AND x.status='done' AND x.stageDevice IS NOT NULL AND x.stageInode IS NOT NULL)
      WHERE l.kind='managed';
    CREATE TABLE metadata_edits (
      id TEXT PRIMARY KEY,trackId TEXT NOT NULL,rootId TEXT NOT NULL,relative TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('preparing','staged','published','committed','done','aborted','recovery-required')),
      journal TEXT NOT NULL,error TEXT,createdAt INTEGER NOT NULL);
    CREATE UNIQUE INDEX metadata_edit_active_target ON metadata_edits(trackId) WHERE phase NOT IN ('done','aborted');
    PRAGMA user_version=4; COMMIT;`);
}
export function pendingMetadataEdits(db: DatabaseSync) {
  return Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
      )
      .get()!.n,
  );
}
export const metadataArtifact = (filename: string) =>
  filename
    .split(/[\\/]/)
    .some(
      (part) =>
        part.startsWith(".rio-publication-") ||
        part.startsWith(".rio-metadata-"),
    );
