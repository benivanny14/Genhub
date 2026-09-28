-- =============================================================================
-- GENHUB - The host's own byte count per upload
--
-- A creator watching an upload cannot tell "the file is on its way" from "the
-- file never arrived": the browser's percentage counts bytes handed to the
-- socket, and Bunny's API answers `0 / queued` in both cases (measured — half a
-- file PATCHed and acknowledged at offset 1 424 104 came back with the same
-- zeros as an untouched slot). These two columns are what make the difference
-- visible next to the progress bar:
--
--   uploadSizeBytes   the creator's own file size, recorded at creation
--   bunnyStorageBytes Bunny's `storageSize`, i.e. what the host reports holding
--
-- Both are additive and nullable, so every existing row is untouched and NULL
-- reads as "the host has not reported a size yet" rather than as zero.
-- =============================================================================

ALTER TABLE "Video" ADD COLUMN "uploadSizeBytes"   INTEGER;
ALTER TABLE "Video" ADD COLUMN "bunnyStorageBytes" INTEGER;
