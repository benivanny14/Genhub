-- =============================================================================
-- GENHUB - One coupon redemption per customer
--
-- `Coupon.maxUses` is a global budget. Nothing connected it to a person: one
-- account could spend all of it, and a coupon created without `maxUses` was
-- unlimited per person as well as in total.
--
-- CouponRedemption is that missing rule, and it is a table rather than a counter
-- because the constraint has to be enforceable by the database: the unique pair
-- (couponId, userId) is what makes consumeCoupon() safe when two settlements
-- race, and it is also the record of WHICH settled charge spent the coupon.
--
-- Additive only: one new table, no existing row read or changed. Existing
-- coupons keep their usedCount untouched, so a coupon already spent under the
-- old rules is not silently re-opened — its remaining budget is whatever
-- maxUses - usedCount says today.
--
-- Who has already used what cannot be reconstructed (nothing recorded it), so
-- every customer starts with a clean slate on the per-account rule. That is the
-- only honest option: inventing redemption rows would be guessing at history.
-- =============================================================================

CREATE TABLE "CouponRedemption" (
    "id"            TEXT NOT NULL,
    "couponId"      TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "transactionId" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- The rule itself: one redemption per customer per coupon.
CREATE UNIQUE INDEX "CouponRedemption_couponId_userId_key"
    ON "CouponRedemption"("couponId", "userId");

CREATE INDEX "CouponRedemption_couponId_idx" ON "CouponRedemption"("couponId");
CREATE INDEX "CouponRedemption_userId_idx" ON "CouponRedemption"("userId");

ALTER TABLE "CouponRedemption"
    ADD CONSTRAINT "CouponRedemption_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponRedemption"
    ADD CONSTRAINT "CouponRedemption_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
