-- A charge whose USSD prompt was accepted but never settled. It is neither a
-- success nor a failure: the customer may already have paid, so it needs a human
-- to check with the mobile network before it becomes one or the other.
--
-- This value is deliberately NOT folded into FAILED. Telling a customer
-- "payment failed, try again" when their money has already left their handset is
-- how one purchase gets charged twice.
ALTER TYPE "TransactionStatus" ADD VALUE IF NOT EXISTS 'UNDER_INVESTIGATION';
