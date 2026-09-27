-- =============================================================================
-- When a creator last received the weekly earnings digest
--
-- The digest job runs on the cron supervisor's poke (hours apart, but never
-- exactly seven days), so the week is enforced here rather than by the schedule:
-- the job only sends when this timestamp is NULL or older than seven days, and
-- claims it with a conditional update before sending. NULL means "never sent",
-- which is also why every existing creator gets their first digest on the next
-- run once they have earnings.
-- =============================================================================

ALTER TABLE "User" ADD COLUMN "lastEarningsDigestAt" TIMESTAMP(3);
