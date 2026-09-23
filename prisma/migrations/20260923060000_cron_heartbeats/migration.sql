-- =============================================================================
-- GENHUB - Background job heartbeats
--
-- A schedule that stops firing produces no request, no log line and no error,
-- so nothing in the app can notice it. Each worker now stamps this table on
-- every run, which turns "silence" into a readable fact: no recent row.
--
-- Additive only: one new table, no existing table or row is touched.
-- =============================================================================

CREATE TABLE "CronHeartbeat" (
    "id"                  TEXT NOT NULL,
    "worker"              TEXT NOT NULL,
    "lastStartedAt"       TIMESTAMP(3),
    "lastFinishedAt"      TIMESTAMP(3),
    "lastOutcome"         TEXT,
    "lastSummary"         TEXT,
    "lastError"           TEXT,
    "lastDurationMs"      INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "runsTotal"           INTEGER NOT NULL DEFAULT 0,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CronHeartbeat_worker_key" ON "CronHeartbeat"("worker");
