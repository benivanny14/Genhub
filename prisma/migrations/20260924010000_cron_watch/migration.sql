-- =============================================================================
-- GENHUB - The watchdog's memory, and who started the last run
--
-- Two facts the recovery notice needs, and the heartbeats cannot carry:
--
--   * CronWatch remembers that a worker was ALREADY reported as needing
--     attention, so "it is fine now" can be told apart from "it has been fine
--     all along". A heartbeat only describes the present; without this memory a
--     worker that recovered an hour ago is indistinguishable from one that never
--     broke, and the operator keeps chasing a schedule that is already fixed.
--     alertedAt is dated from the worker's own silence (the same clock the alarm
--     uses), so the all-clear reads as the mirror of the alarm it takes back.
--
--   * CronHeartbeat.lastOrigin records who started the last run. The uptime
--     watchdog restarts a worker whose schedule has died, so "it is running
--     again" has two very different readings: the schedule came back (fixed) or
--     the only reason there is a run at all is that the watchdog started one
--     (still broken). A column rather than a suffix inside lastSummary, because
--     the notice tests it, and testing a human sentence is how the two drift.
--
-- Additive only: one new table and one nullable column, no existing row touched.
-- =============================================================================

ALTER TABLE "CronHeartbeat" ADD COLUMN "lastOrigin" TEXT;

CREATE TABLE "CronWatch" (
    "id"           TEXT NOT NULL,
    "worker"       TEXT NOT NULL,
    "alertedAt"    TIMESTAMP(3) NOT NULL,
    "alertedState" TEXT NOT NULL,
    "resolvedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronWatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CronWatch_worker_key" ON "CronWatch"("worker");
CREATE INDEX "CronWatch_worker_idx" ON "CronWatch"("worker");
