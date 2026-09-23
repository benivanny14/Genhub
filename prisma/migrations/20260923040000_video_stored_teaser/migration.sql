-- =============================================================================
-- GENHUB - Stored teaser URL for side-loaded content
--
-- The Bunny teaser column (teaserBunnyVideoId) covers uploaded scenes. Rows that
-- serve their media from a stored URL instead of Bunny — demo and migrated
-- content, which use previewUrl — need the same ability to point at a SEPARATE
-- trailer, otherwise they can only offer the whole scene or nothing.
--
-- previewUrl and teaserClipUrl are different assets on purpose: pointing the
-- teaser at previewUrl would recreate the leak the teaser columns exist to
-- close. Nullable, and NULL means "no trailer" — resolveTeaserUrl returns
-- nothing for a paid row in that state rather than falling back to the scene.
-- =============================================================================

ALTER TABLE "Video" ADD COLUMN "teaserClipUrl" TEXT;
