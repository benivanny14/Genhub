-- Payouts move money OUT through the same gateway that collects it, so a payout
-- request now carries the gateway's own record of what it did:
--
--   * "providerWithdrawalId" is NULL for every existing row on purpose. Until
--     now every withdrawal was sent by hand from the Genhub side, so there is no
--     gateway id to backfill — and a NULL is exactly what makes those rows
--     distinguishable from an automatically sent one. It is also the webhook's
--     match key, so it gets an index.
--   * "providerFee" / "providerNetAmount" are the gateway's own fee and the
--     amount that reached the creator. NULL until a payout is sent through the
--     gateway; the recipient is paid netAmount, which is less than the amount
--     requested, and that difference must be a stored number rather than an
--     assumption made by whoever reads the row.
--   * "providerStatus" is the gateway's last word (pending/completed/failed).
ALTER TABLE "PayoutRequest"
    ADD COLUMN "providerWithdrawalId" TEXT,
    ADD COLUMN "providerFee" INTEGER,
    ADD COLUMN "providerNetAmount" INTEGER,
    ADD COLUMN "providerStatus" TEXT;

CREATE INDEX "PayoutRequest_providerWithdrawalId_idx"
    ON "PayoutRequest"("providerWithdrawalId");
