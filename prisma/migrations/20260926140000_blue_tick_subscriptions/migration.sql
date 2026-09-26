-- =============================================================================
-- Paid blue tick (creator verification bought by the month)
--
-- The badge stops being only an admin decision: a creator pays TZS 10,000 for
-- a month, an admin approves it, and it expires by itself when the month ends.
-- "verifiedUntil" is what makes the ending automatic — NULL keeps the existing
-- meaning for every row, including a badge an admin granted by hand, which must
-- not suddenly acquire an expiry it never had.
-- =============================================================================

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'BLUE_TICK';

ALTER TABLE "User" ADD COLUMN "verifiedUntil" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "BlueTickStatus" AS ENUM ('PAID', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "BlueTickRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "status" "BlueTickStatus" NOT NULL DEFAULT 'PAID',
    "paymentMethod" TEXT NOT NULL,
    "transactionId" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlueTickRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlueTickRequest_userId_idx" ON "BlueTickRequest"("userId");

-- CreateIndex
CREATE INDEX "BlueTickRequest_status_idx" ON "BlueTickRequest"("status");

-- CreateIndex
CREATE INDEX "BlueTickRequest_expiresAt_idx" ON "BlueTickRequest"("expiresAt");

-- AddForeignKey
ALTER TABLE "BlueTickRequest" ADD CONSTRAINT "BlueTickRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
