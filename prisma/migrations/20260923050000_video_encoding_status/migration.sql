-- =============================================================================
-- GENHUB - Video encoding lifecycle (Bunny Stream)
--
-- Bunny accepts an upload seconds after the creator's browser starts sending,
-- but the video is unplayable until transcoding finishes. These columns record
-- what Bunny says, so the product can tell a creator the truth instead of
-- publishing a dead player.
--
-- encodingStatus NULL = not tracked (side-loaded/demo rows): those keep working
-- exactly as before this migration. All columns are additive and nullable or
-- defaulted, so existing rows are untouched.
-- =============================================================================

ALTER TABLE "Video" ADD COLUMN "encodingStatus"     INTEGER;
ALTER TABLE "Video" ADD COLUMN "encodeProgress"     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Video" ADD COLUMN "encodingError"      TEXT;
ALTER TABLE "Video" ADD COLUMN "encodingCheckedAt"  TIMESTAMP(3);
ALTER TABLE "Video" ADD COLUMN "encodingNotifiedAt" TIMESTAMP(3);

CREATE INDEX "Video_encodingStatus_idx" ON "Video"("encodingStatus");
