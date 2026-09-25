-- =============================================================================
-- Payout payment reference (the M-Pesa / bank receipt number)
--
-- Additive and nullable, so it applies to a live table with rows in it: every
-- existing payout keeps a null reference, which is the truth — nobody recorded
-- one before this column existed. No backfill, no new index, no lock that
-- matters.
--
-- Why: marking a payout PAID used to be an assertion with nothing behind it. The
-- admin typed a free-text note and the creator was told "paid" with no way to
-- check. The receipt number is the one thing the sender actually holds, and it
-- is what the creator compares against the SMS on their handset.
-- =============================================================================

ALTER TABLE "PayoutRequest" ADD COLUMN "paymentReference" TEXT;
