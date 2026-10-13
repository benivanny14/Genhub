ALTER TABLE "Video"
ADD COLUMN "streamtapeFileId" TEXT;

ALTER TABLE "Video"
ALTER COLUMN "bunnyVideoId" DROP NOT NULL;

UPDATE "Video"
SET "isPublished" = false,
    "isDraft" = true,
    "scheduledAt" = NULL
WHERE "isDeleted" = false
  AND "streamtapeFileId" IS NULL;

CREATE UNIQUE INDEX "Video_streamtapeFileId_key" ON "Video"("streamtapeFileId");

CREATE TABLE "StreamtapeUpload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "totalBytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'UPLOADING',
    "remoteUploadId" TEXT,
    "streamtapeFileId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamtapeUpload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StreamtapeUpload_objectKey_key" ON "StreamtapeUpload"("objectKey");
CREATE UNIQUE INDEX "StreamtapeUpload_remoteUploadId_key" ON "StreamtapeUpload"("remoteUploadId");
CREATE UNIQUE INDEX "StreamtapeUpload_streamtapeFileId_key" ON "StreamtapeUpload"("streamtapeFileId");
CREATE INDEX "StreamtapeUpload_userId_state_idx" ON "StreamtapeUpload"("userId", "state");
CREATE INDEX "StreamtapeUpload_state_createdAt_idx" ON "StreamtapeUpload"("state", "createdAt");

ALTER TABLE "StreamtapeUpload"
ADD CONSTRAINT "StreamtapeUpload_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
