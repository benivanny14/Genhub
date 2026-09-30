-- Admin-granted free access (see User.freeAccess in schema.prisma).
--
-- While this is true, resolveVideoEntitlement grants the account every paid
-- scene without a purchase, subscription or charge. It defaults to false, so
-- every existing account keeps paying exactly as before — the column grants
-- nothing until an admin turns it on for one user.
ALTER TABLE "User" ADD COLUMN "freeAccess" BOOLEAN NOT NULL DEFAULT false;
