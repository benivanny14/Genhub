-- =============================================================================
-- GENHUB - Cron run lock
--
-- Two triggers can reach the same worker at the same moment: Vercel Cron and a
-- GitHub Actions workflow are both supported schedulers, and the admin panel
-- can start a worker by hand. For renew-subscriptions that means sending a USSD
-- charge request to the same fan twice.
--
-- A single conditional UPDATE on this column turns that into a lost race
-- instead of a second charge. Null means free; a run that dies without
-- releasing it expires after the worker's own in-flight grace.
--
-- Additive only: one nullable column, no existing row is touched.
-- =============================================================================

ALTER TABLE "CronHeartbeat" ADD COLUMN "runLockedAt" TIMESTAMP(3);
