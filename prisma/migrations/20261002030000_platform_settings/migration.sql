-- Platform settings: operator switches that affect every account.
--
-- The first one is the admin's "all videos are free right now" toggle. A
-- key/value table so the next switch does not need its own migration. See the
-- PlatformSetting comment in schema.prisma and
-- src/lib/services/platform-setting.service.ts.

CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "PlatformSetting_key_idx" ON "PlatformSetting"("key");
