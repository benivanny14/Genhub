-- Scheduled publishing and drafts for creator posts.
--
-- A creator writing a scene at night wants to publish it in the morning, or to
-- leave it half-written without it going live. The row stays isPublished=false
-- until the scheduled time passes, so the feed's existing filter hides it; a
-- sweep flips it. See the Video comment in schema.prisma.

ALTER TABLE "Video" ADD COLUMN "isDraft" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Video" ADD COLUMN "scheduledAt" TIMESTAMP(3);

CREATE INDEX "Video_scheduledAt_idx" ON "Video"("scheduledAt");
