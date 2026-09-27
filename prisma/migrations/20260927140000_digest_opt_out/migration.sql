-- =============================================================================
-- Whether a creator receives the weekly earnings digest
--
-- Opt-out, not opt-in: the digest is the one message that explains the 14-day
-- hold in the creator's own words, so it is on for everyone by default and only
-- stops when a creator says so. Existing accounts get the default (true) — they
-- have been getting nothing, and the digest is the explanation for the wait they
-- are already living with.
-- =============================================================================

ALTER TABLE "User" ADD COLUMN "earningsDigestEnabled" BOOLEAN NOT NULL DEFAULT true;
