-- =============================================================================
-- Creator guidelines accepted on the account, not in the browser
--
-- The acknowledgement of the creator rules used to live only in localStorage,
-- keyed by user id. That made it a receipt for one device: a creator who
-- accepted on their phone was shown nothing on their laptop, and clearing site
-- data silently erased the record. Storing the version on the account makes the
-- re-acceptance gate (bump CREATOR_GUIDELINES_VERSION -> everyone is asked
-- again) the same everywhere, and gives a server-side answer to "what did this
-- account actually agree to, and when?".
--
-- Default 0 means "never accepted", so every existing account is asked once the
-- next time it opens the upload screen. That is deliberate: there is no evidence
-- any of them read the rules that produced this column.
-- =============================================================================

ALTER TABLE "User" ADD COLUMN "guidelinesAcceptedVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "guidelinesAcceptedAt" TIMESTAMP(3);
