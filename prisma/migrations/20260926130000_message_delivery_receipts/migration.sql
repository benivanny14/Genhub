-- =============================================================================
-- End-to-end delivery receipts for paid messages
--
-- deliveredAt defaults to now() and is NOT NULL: every existing message was, in
-- fact, delivered — it is sitting in the table — so backfilling it from
-- createdAt states the truth rather than inventing a timestamp. readAt is NULL
-- for messages whose isRead we cannot reconstruct with a time.
-- =============================================================================

ALTER TABLE "PayMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PayMessage" ADD COLUMN "readAt" TIMESTAMP(3);

UPDATE "PayMessage" SET "deliveredAt" = "createdAt";
UPDATE "PayMessage" SET "readAt" = "createdAt" WHERE "isRead" = true;
