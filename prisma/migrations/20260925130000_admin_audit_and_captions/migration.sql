-- =============================================================================
-- Admin audit log, and captions on a video
--
-- Two unrelated changes in one migration because they are both schema additions
-- that shipped together; neither touches existing rows, so applying this is a
-- CREATE TABLE and a nullable ADD COLUMN — no backfill, no lock that matters.
-- =============================================================================

-- What an admin did, to whom, and why. See the model comment in schema.prisma:
-- until this table existed, the only record of a ban or a payout approval was
-- its consequence, and the fields that held the reason were overwritten by the
-- next decision.
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_actorId_idx" ON "AdminAuditLog"("actorId");
CREATE INDEX "AdminAuditLog_action_idx" ON "AdminAuditLog"("action");
CREATE INDEX "AdminAuditLog_targetId_idx" ON "AdminAuditLog"("targetId");
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- Captions. Nullable, so every existing video keeps working exactly as it did
-- (no captions) and the player only renders a <track> when a creator attaches
-- one.
ALTER TABLE "Video" ADD COLUMN "captionsUrl" TEXT;
