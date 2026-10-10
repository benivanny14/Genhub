-- The clip behind every page used to be a file in `public/uploads/site/`, written
-- by the upload route and streamed back by the serving route. That works on a
-- machine with a disk and cannot work on the deployment: Vercel's `public/` is
-- read-only, `/tmp` belongs to a single instance and is discarded, and a
-- function's request and response bodies are both capped at 4.5 MB. So the file
-- had never been stored there — a 6 MB upload was refused by the platform before
-- the route ran at all, and anything that did reach it answered
-- "This server cannot store a video right now."
--
-- The clip is now a row. `id` is the same 24-hex token the settings row carries
-- and the browser puts in `?v=`, so it is still the only thing that decides which
-- bytes a request may read — but it is a primary key now rather than a filename,
-- and nothing is interpolated into a path.
--
-- `size` duplicates `octet_length(data)` deliberately: a HEAD, a 416 and every
-- range request need the length, and none of them should have to pull the clip
-- out of storage to learn it.
CREATE TABLE "BackgroundVideoAsset" (
    "id" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundVideoAsset_pkey" PRIMARY KEY ("id")
);
