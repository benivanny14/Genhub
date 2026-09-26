-- =============================================================================
-- Warnings that have to be read, and setup steps that can be finished
--
-- Two rows that both answer "did this actually happen?":
--
--   * StrikeLog.acknowledgedAt — NULL is "issued but never seen". The creator's
--     dashboard blocks on the unacknowledged ones, so a warning stops being a
--     line in a bell nobody opened.
--   * SetupStep — a manual launch step (funding the gateway float, allowing the
--     domain as a referrer) that no code can verify. These were counted as
--     "todo" forever, which is why the admin Setup badge never cleared.
-- =============================================================================

ALTER TABLE "StrikeLog" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);

CREATE TABLE "SetupStep" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneBy" TEXT,

    CONSTRAINT "SetupStep_pkey" PRIMARY KEY ("id")
);

-- Existing warnings are NOT back-filled as read: there is no evidence anybody
-- saw them, and marking them read would hide a warning that may still matter.
