-- The appeals queue: one row per request from a suspended or rejected account,
-- with the verdict and its author. See the Appeal comment in schema.prisma.

CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BAN',
    "message" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewerNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Appeal_status_idx" ON "Appeal"("status");
CREATE INDEX "Appeal_userId_idx" ON "Appeal"("userId");
CREATE INDEX "Appeal_createdAt_idx" ON "Appeal"("createdAt");

ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
