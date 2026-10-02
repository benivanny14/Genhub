-- The journey of one charge: one append-only row per thing that happened.
-- `Transaction.status` keeps only the last state, so a FAILED row could not say
-- whether a USSD prompt was sent, whether a webhook arrived, or what the
-- customer was shown. See the PaymentEvent comment in schema.prisma and
-- src/lib/services/payment-journey.service.ts.

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentEvent_transactionId_idx" ON "PaymentEvent"("transactionId");
CREATE INDEX "PaymentEvent_kind_idx" ON "PaymentEvent"("kind");
CREATE INDEX "PaymentEvent_createdAt_idx" ON "PaymentEvent"("createdAt");

ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
