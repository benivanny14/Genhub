-- =============================================================================
-- Creator inbox control, and an admin freeze on withdrawals
--
-- Both are additive and safe on a live table with rows in it:
--   * messagesEnabled has a DEFAULT of true, so every existing account keeps
--     receiving messages exactly as it did — nobody is silently muted.
--   * payoutFrozenUntil / payoutFrozenReason are NULL for everyone, which is
--     the truth: no creator is frozen until an admin says so.
-- No backfill, no new index, no lock that matters.
-- =============================================================================

ALTER TABLE "User" ADD COLUMN "messagesEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "payoutFrozenUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "payoutFrozenReason" TEXT;
