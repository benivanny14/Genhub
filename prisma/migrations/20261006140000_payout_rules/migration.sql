-- Two columns for the withdrawal rules, both documenting a deliberate default:
--
--   * "payoutMinimumWaived" is OFF for every existing account. A creator may
--     withdraw only once their balance reaches the TZS 30,000 floor; an admin
--     turns this on for one account to let it withdraw below the floor.
--   * "payoutReadyNotifiedAt" is NULL, meaning no creator has been announced to
--     the admins yet. It is set when a creator's available balance crosses the
--     floor and cleared when a payout takes them back below it.
ALTER TABLE "User"
    ADD COLUMN "payoutMinimumWaived" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CreatorBalance"
    ADD COLUMN "payoutReadyNotifiedAt" TIMESTAMP(3);
