-- =============================================================================
-- GENHUB - Separate teaser clip for paid scenes
--
-- Why this column exists: a Bunny token authorises a PATH, not a duration, so
-- "teasing" a premium video by signing its own playlist hands a non-buyer the
-- ENTIRE scene for the life of the token. The only way to show a preview without
-- giving the scene away is to preview a different asset.
--
-- Nullable on purpose. NULL means "no teaser available", and resolveTeaserUrl
-- returns nothing for a paid video in that state rather than falling back to the
-- main stream. Uniqueness matches bunnyVideoId: one Bunny video is either a
-- scene or a teaser for exactly one row, never both.
-- =============================================================================

ALTER TABLE "Video" ADD COLUMN "teaserBunnyVideoId" TEXT;

CREATE UNIQUE INDEX "Video_teaserBunnyVideoId_key" ON "Video"("teaserBunnyVideoId");
